import { normalizeMessageContent } from "../common";

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

  const messages: Array<{ role: string; content: unknown }> = [];
  if (instructions && instructions.trim()) messages.push({ role: "system", content: instructions.trim() });

  if (typeof input === "string") {
    if (input.trim()) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const itemObj = item as Record<string, unknown>;
      const role = (itemObj as any).role === "assistant" ? "assistant" : (itemObj as any).role === "system" ? "system" : "user";
      const content = Array.isArray((itemObj as any).content) ? partsToOpenAiContent((itemObj as any).content) : normalizeMessageContent((itemObj as any).content);
      messages.push({ role, content });
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

  return {
    id: (typeof (chatObj as any).id === "string" && String((chatObj as any).id).trim() ? String((chatObj as any).id) : `resp_${Date.now().toString(36)}`),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || "",
    output_text: text || "",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: text || "" }],
      },
    ],
    usage: (chatObj as any).usage ?? undefined,
  };
}

