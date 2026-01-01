import { normalizeMessageContent, normalizeToolCallsFromChatMessage } from "../common";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function partsToOpenAiContent(parts: unknown): Array<{ type: string; text?: string; image_url?: { url: string } }> | "" {
  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== "object") continue;
    const t = (p as Record<string, unknown>).type;
    if (t === "input_text" && typeof (p as any).text === "string") {
      out.push({ type: "text", text: String((p as any).text) });
      continue;
    }
    if (t === "input_image") {
      const pObj = p as Record<string, unknown>;
      const imageUrl = (pObj as any).image_url;
      const url =
        typeof imageUrl === "string"
          ? imageUrl
          : imageUrl && typeof imageUrl === "object" && typeof (imageUrl as Record<string, unknown>).url === "string"
            ? String((imageUrl as Record<string, unknown>).url)
            : "";
      if (typeof url === "string" && url) out.push({ type: "image_url", image_url: { url } });
      continue;
    }
  }
  if (!out.length) return "";
  return out;
}

export function responsesRequestToOpenAIChat(reqJson: unknown): Record<string, unknown> {
  const body = isPlainObject(reqJson) ? reqJson : {};
  const instructions = typeof (body as any).instructions === "string" ? String((body as any).instructions) : "";
  const input = (body as any).input;

  const messages: Array<Record<string, unknown>> = [];
  if (instructions && instructions.trim()) messages.push({ role: "system", content: instructions.trim() });

  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const itemObj = item as Record<string, unknown>;
      const t = typeof (itemObj as any).type === "string" ? String((itemObj as any).type).trim() : "";

      // Tool calling: Responses input items -> Chat Completions messages
      if (t === "function_call") {
        const callIdRaw = (itemObj as any).call_id ?? (itemObj as any).callId ?? (itemObj as any).id;
        const callId = typeof callIdRaw === "string" && callIdRaw.trim() ? callIdRaw.trim() : `call_${crypto.randomUUID().replace(/-/g, "")}`;
        const name = typeof (itemObj as any).name === "string" ? String((itemObj as any).name).trim() : "";
        const args = (itemObj as any).arguments;
        const argStr =
          typeof args === "string"
            ? args
            : args == null
              ? "{}"
              : (() => {
                  try {
                    return JSON.stringify(args);
                  } catch {
                    return "{}";
                  }
                })();
        if (!name) continue;
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name, arguments: argStr } }],
        });
        continue;
      }

      if (t === "function_call_output") {
        const callIdRaw = (itemObj as any).call_id ?? (itemObj as any).callId ?? (itemObj as any).id;
        const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
        const output = normalizeMessageContent((itemObj as any).output ?? (itemObj as any).content ?? "");
        if (!callId) continue;
        messages.push({ role: "tool", tool_call_id: callId, content: output ?? "" });
        continue;
      }

      const role =
        (itemObj as any).role === "assistant" ? "assistant" : (itemObj as any).role === "system" ? "system" : (itemObj as any).role === "tool" ? "tool" : "user";
      const content = Array.isArray((itemObj as any).content) ? partsToOpenAiContent((itemObj as any).content) : normalizeMessageContent((itemObj as any).content);

      // If a tool message was sent in "message" form, try to preserve the call id.
      const toolCallId = role === "tool" ? normalizeMessageContent((itemObj as any).tool_call_id ?? (itemObj as any).toolCallId ?? (itemObj as any).call_id) : "";
      if (role === "tool" && typeof toolCallId === "string" && toolCallId.trim()) {
        messages.push({ role, tool_call_id: toolCallId.trim(), content: content ?? "" });
      } else {
        messages.push({ role, content });
      }
    }
  }

  const tools = Array.isArray((body as any).tools) ? (body as any).tools : undefined;
  const toolChoice = (body as any).tool_choice ?? undefined;

  return {
    model: typeof (body as any).model === "string" ? String((body as any).model) : "",
    messages,
    tools,
    tool_choice: toolChoice,
    stream: Boolean((body as any).stream),
    temperature: (body as any).temperature,
    top_p: (body as any).top_p,
    max_tokens: (body as any).max_output_tokens ?? (body as any).max_tokens,
  };
}

export function openAIChatResponseToResponses(chatJson: unknown, model: string): Record<string, unknown> {
  const chatObj = chatJson && typeof chatJson === "object" ? (chatJson as Record<string, unknown>) : {};
  const choices = Array.isArray((chatObj as any).choices) ? ((chatObj as any).choices as unknown[]) : [];
  const choice0 = choices.length ? (choices[0] as Record<string, unknown>) : null;
  const msg = choice0 && typeof (choice0 as any).message === "object" ? ((choice0 as any).message as Record<string, unknown>) : null;
  const text = msg ? normalizeMessageContent((msg as any).content) : "";
  const toolCalls = msg ? normalizeToolCallsFromChatMessage(msg) : [];

  const rawChatId = typeof (chatObj as any).id === "string" ? String((chatObj as any).id) : "";
  const respId =
    rawChatId && rawChatId.startsWith("chatcmpl_") ? rawChatId.slice("chatcmpl_".length) || `resp_${Date.now().toString(36)}` : rawChatId || `resp_${Date.now().toString(36)}`;

  const output: any[] = [];
  // Preserve the previous behavior (always return a message item) unless the model only returned tool calls.
  if ((typeof text === "string" && text) || !toolCalls.length) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: text || "" }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: `fc_${tc.call_id}`,
      call_id: tc.call_id,
      name: tc.name,
      arguments: tc.arguments,
      ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
      ...(typeof tc.thought === "string" ? { thought: tc.thought } : {}),
    });
  }

  return {
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || "",
    output_text: text || "",
    output,
    usage: (chatObj as any).usage ?? undefined,
  };
}
