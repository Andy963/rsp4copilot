import { normalizeMessageContent, normalizeToolCallsFromChatMessage } from "../common";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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

function responsesToolsToChatTools(tools: unknown): unknown[] | undefined {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return undefined;

  const out: any[] = [];
  for (const t0 of list) {
    if (!t0 || typeof t0 !== "object") continue;
    const t = t0 as any;
    if (t.type !== "function") continue;

    // OpenAI Responses tools format:
    //   { type:"function", name, description?, parameters? }
    // OpenAI Chat Completions tools format:
    //   { type:"function", function:{ name, description?, parameters? } }
    if (t.function && typeof t.function === "object") {
      const name = typeof t.function.name === "string" ? t.function.name.trim() : "";
      if (!name) continue;
      out.push({ type: "function", function: { ...t.function, name } });
      continue;
    }

    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) continue;
    const fn: any = { name };
    if (typeof t.description === "string" && t.description.trim()) fn.description = t.description.trim();
    if (t.parameters && typeof t.parameters === "object") fn.parameters = t.parameters;
    out.push({ type: "function", function: fn });
  }

  return out.length ? out : undefined;
}

function responsesToolChoiceToChatToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;

  // Pass through strings like "auto"/"none"/"required" where used.
  if (typeof toolChoice === "string") return toolChoice;

  // Responses: { type:"function", name }
  // Chat:      { type:"function", function:{ name } }
  if (toolChoice && typeof toolChoice === "object" && (toolChoice as any).type === "function") {
    const obj = toolChoice as any;
    if (obj.function && typeof obj.function === "object") return toolChoice;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) return toolChoice;
    return { type: "function", function: { name } };
  }

  return toolChoice;
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

  const tools = responsesToolsToChatTools((body as any).tools);
  const toolChoice = responsesToolChoiceToChatToolChoice((body as any).tool_choice ?? undefined);

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
  const reasoningText = msg ? coerceThinkingText((msg as any).reasoning_content ?? (msg as any).thinking ?? (msg as any).reasoning ?? (msg as any).summary) : "";
  const toolCalls = msg ? normalizeToolCallsFromChatMessage(msg) : [];

  const rawChatId = typeof (chatObj as any).id === "string" ? String((chatObj as any).id) : "";
  const respId = (() => {
    if (rawChatId && rawChatId.startsWith("resp_")) return rawChatId;
    if (rawChatId && rawChatId.startsWith("chatcmpl_")) {
      const suffix = rawChatId.slice("chatcmpl_".length);
      if (suffix) return `resp_${suffix}`;
    }
    return `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  })();
  const idSuffix = respId.startsWith("resp_") ? respId.slice("resp_".length) : respId;
  const messageItemId = `msg_${idSuffix || crypto.randomUUID().replace(/-/g, "")}`;
  const reasoningItemId = `rs_${idSuffix || crypto.randomUUID().replace(/-/g, "")}`;

  const output: any[] = [];
  if (reasoningText && reasoningText.trim()) {
    output.push({
      id: reasoningItemId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
      content: [{ type: "reasoning_text", text: reasoningText }],
    });
  }
  // Preserve the previous behavior (always return a message item) unless the model only returned tool calls.
  if ((typeof text === "string" && text) || !toolCalls.length) {
    output.push({
      id: messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: text || "" }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: `fc_${tc.call_id}`,
      status: "completed",
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
    status: "completed",
    output_text: text || "",
    output,
    usage: (chatObj as any).usage ?? undefined,
  };
}
