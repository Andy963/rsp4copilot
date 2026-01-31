function coerceThinkingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.thinking === "string") return obj.thinking;
    if (typeof obj.reasoning === "string") return obj.reasoning;
    if (typeof obj.summary === "string") return obj.summary;
    if (typeof obj.value === "string") return obj.value;
  }
  return "";
}

export function extractDeltaTextFromOpenAIChatChunk(obj: unknown): string {
  const chunkObj = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const choices = Array.isArray((chunkObj as any).choices) ? ((chunkObj as any).choices as unknown[]) : [];
  const c0 = choices.length ? (choices[0] as any) : null;
  const delta = c0 && typeof c0.delta === "object" ? (c0.delta as any) : null;
  if (delta && typeof delta.content === "string") return delta.content;
  return "";
}

export function extractDeltaReasoningFromOpenAIChatChunk(obj: unknown): string {
  const chunkObj = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const choices = Array.isArray((chunkObj as any).choices) ? ((chunkObj as any).choices as unknown[]) : [];
  const c0 = choices.length ? (choices[0] as any) : null;
  if (!c0 || typeof c0 !== "object") return "";

  const delta = c0 && typeof c0.delta === "object" ? (c0.delta as any) : null;
  const fromDelta = delta ? coerceThinkingText(delta.reasoning_content ?? delta.thinking ?? delta.reasoning ?? delta.summary) : "";
  if (typeof fromDelta === "string" && fromDelta) return fromDelta;

  const fromChoice = coerceThinkingText((c0 as any).thinking ?? (c0 as any).reasoning_content);
  if (typeof fromChoice === "string" && fromChoice) return fromChoice;

  return "";
}

export function extractToolCallDeltasFromOpenAIChatChunk(
  obj: unknown,
): Array<{ index: number; id?: string; name?: string; argumentsDelta?: string; thoughtSignature?: string; thought?: string }> {
  const chunkObj = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const choices = Array.isArray((chunkObj as any).choices) ? ((chunkObj as any).choices as any[]) : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? (c0.delta as any) : null;
  const toolCalls = delta && Array.isArray(delta.tool_calls) ? (delta.tool_calls as any[]) : [];
  const out: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string; thoughtSignature?: string; thought?: string }> = [];

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const index = Number.isInteger((tc as any).index) ? (tc as any).index : 0;
    const id = typeof (tc as any).id === "string" && (tc as any).id.trim() ? (tc as any).id.trim() : undefined;
    const fn = (tc as any).function && typeof (tc as any).function === "object" ? (tc as any).function : null;
    const name = fn && typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : undefined;
    const argumentsDelta = fn && typeof fn.arguments === "string" && fn.arguments ? fn.arguments : undefined;
    const thoughtSignature =
      (tc as any).thought_signature ??
      (tc as any).thoughtSignature ??
      (fn ? (fn as any).thought_signature ?? (fn as any).thoughtSignature : undefined);
    const thought = (tc as any).thought ?? (tc as any).reasoning ?? (fn ? (fn as any).thought ?? (fn as any).reasoning : undefined);

    out.push({
      index,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(argumentsDelta ? { argumentsDelta } : {}),
      ...(typeof thoughtSignature === "string" && thoughtSignature.trim() ? { thoughtSignature: thoughtSignature.trim() } : {}),
      ...(typeof thought === "string" ? { thought } : {}),
    });
  }

  return out;
}

