export function geminiArgsToJsonString(args: unknown): string {
  if (typeof args === "string") return args;
  if (args == null) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

export function geminiFinishReasonToOpenai(finishReason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  const v = typeof finishReason === "string" ? finishReason.trim().toLowerCase() : "";
  if (!v) return "stop";
  if (v === "stop") return "stop";
  if (v === "max_tokens" || v === "max_tokens_reached" || v === "length") return "length";
  if (v === "safety" || v === "recitation" || v === "content_filter") return "content_filter";
  return "stop";
}

export function geminiUsageToOpenaiUsage(usageMetadata: unknown): any | null {
  const u = usageMetadata && typeof usageMetadata === "object" ? (usageMetadata as any) : null;
  const prompt = Number.isInteger(u?.promptTokenCount) ? u.promptTokenCount : null;
  const completion = Number.isInteger(u?.candidatesTokenCount) ? u.candidatesTokenCount : null;
  const total = Number.isInteger(u?.totalTokenCount)
    ? u.totalTokenCount
    : Number.isInteger(prompt) && Number.isInteger(completion)
      ? prompt + completion
      : null;

  if (!Number.isInteger(prompt) && !Number.isInteger(completion) && !Number.isInteger(total)) return null;
  return {
    prompt_tokens: Number.isInteger(prompt) ? prompt : 0,
    completion_tokens: Number.isInteger(completion) ? completion : 0,
    total_tokens: Number.isInteger(total) ? total : (Number.isInteger(prompt) ? prompt : 0) + (Number.isInteger(completion) ? completion : 0),
  };
}

export function geminiExtractTextAndToolCalls(respJson: unknown): {
  text: string;
  reasoning: string;
  toolCalls: any[];
  finish_reason: string;
  usage: any | null;
} {
  const root = respJson && typeof respJson === "object" ? (respJson as any) : null;
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const cand = candidates.length ? candidates[0] : null;

  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];

  let text = "";
  let reasoning = "";
  let thoughtSummarySoFar = "";
  const toolCalls: any[] = [];

  // Track the most recent thought/thought_signature for the next function call (2025 API)
  let pendingThought = "";
  let pendingThoughtSignature = "";

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;

    // Thought summary text comes through as `text` with `thought: true`
    if ((p as any).thought === true && typeof (p as any).text === "string") {
      const thoughtSummaryText = (p as any).text;
      if (thoughtSummaryText) {
        if (thoughtSummaryText.startsWith(thoughtSummarySoFar)) {
          thoughtSummarySoFar = thoughtSummaryText;
        } else if (thoughtSummarySoFar.startsWith(thoughtSummaryText)) {
          // ignore (already have a longer buffer)
        } else {
          thoughtSummarySoFar += thoughtSummaryText;
        }
      }
      continue;
    }

    // Check for functionCall first (2025 API: thoughtSignature is sibling to functionCall in same part)
    const fc = (p as any).functionCall;
    if (fc && typeof fc === "object") {
      const name = typeof (fc as any).name === "string" ? String((fc as any).name).trim() : "";
      if (!name) continue;
      const argsStr = geminiArgsToJsonString((fc as any).args);
      const tcItem: any = {
        id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: { name, arguments: argsStr && argsStr.trim() ? argsStr : "{}" },
      };

      // Extract thought_signature from the same part (2025 API: thoughtSignature is sibling to functionCall)
      const thoughtSig =
        (p as any).thoughtSignature ||
        (p as any).thought_signature ||
        (fc as any).thoughtSignature ||
        (fc as any).thought_signature ||
        pendingThoughtSignature ||
        "";
      const thought = (p as any).thought || (fc as any).thought || pendingThought || "";

      if (typeof thoughtSig === "string" && thoughtSig.trim()) {
        tcItem.thought_signature = thoughtSig.trim();
      }
      if (typeof thought === "string" && thought) {
        tcItem.thought = thought;
        reasoning += thought;
      }
      toolCalls.push(tcItem);

      // Reset pending thought after consuming
      pendingThought = "";
      pendingThoughtSignature = "";
      continue;
    }

    // Handle text parts
    if (typeof (p as any).text === "string" && (p as any).text) {
      text += (p as any).text;
      continue;
    }

    // Handle standalone thought parts (if they come separately)
    if (
      typeof (p as any).thought === "string" ||
      typeof (p as any).thought_signature === "string" ||
      typeof (p as any).thoughtSignature === "string"
    ) {
      if (typeof (p as any).thought === "string") {
        pendingThought = (p as any).thought;
        if ((p as any).thought) reasoning += (p as any).thought;
      }
      if (typeof (p as any).thought_signature === "string") pendingThoughtSignature = (p as any).thought_signature;
      if (typeof (p as any).thoughtSignature === "string") pendingThoughtSignature = (p as any).thoughtSignature;
      continue;
    }
  }

  const finishReasonRaw = cand?.finishReason ?? cand?.finish_reason;
  const finish_reason = geminiFinishReasonToOpenai(finishReasonRaw, toolCalls.length > 0);
  const combinedReasoning = [thoughtSummarySoFar, reasoning]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join("\n\n");
  return { text, reasoning: combinedReasoning, toolCalls, finish_reason, usage: geminiUsageToOpenaiUsage(root?.usageMetadata) };
}

