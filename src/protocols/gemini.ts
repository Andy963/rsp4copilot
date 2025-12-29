import { normalizeMessageContent } from "../common";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function geminiPartsToOpenAiContent(parts: unknown): Array<{ type: string; text?: string; image_url?: { url: string } }> | "" {
  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== "object") continue;
    const pObj = p as Record<string, unknown>;
    if (typeof (pObj as any).text === "string") {
      out.push({ type: "text", text: String((pObj as any).text) });
      continue;
    }
    const inlineData = isPlainObject((pObj as any).inlineData) ? ((pObj as any).inlineData as Record<string, unknown>) : null;
    if (inlineData && typeof (inlineData as any).data === "string" && String((inlineData as any).data).trim()) {
      const mt = typeof (inlineData as any).mimeType === "string" && String((inlineData as any).mimeType).trim() ? String((inlineData as any).mimeType).trim() : "application/octet-stream";
      const url = `data:${mt};base64,${String((inlineData as any).data).trim()}`;
      out.push({ type: "image_url", image_url: { url } });
      continue;
    }
    const fileData = isPlainObject((pObj as any).fileData) ? ((pObj as any).fileData as Record<string, unknown>) : null;
    if (fileData && typeof (fileData as any).fileUri === "string" && String((fileData as any).fileUri).trim()) {
      out.push({ type: "image_url", image_url: { url: String((fileData as any).fileUri).trim() } });
      continue;
    }
  }
  if (!out.length) return "";
  return out;
}

function geminiToolsToOpenAiTools(tools: unknown): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
  const list = Array.isArray(tools) ? tools : [];
  const out: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> = [];
  for (const t of list) {
    const decls = isPlainObject(t) && Array.isArray((t as any).functionDeclarations) ? ((t as any).functionDeclarations as unknown[]) : null;
    if (!decls) continue;
    for (const fd of decls) {
      if (!fd || typeof fd !== "object") continue;
      const fdObj = fd as Record<string, unknown>;
      const name = typeof (fdObj as any).name === "string" ? String((fdObj as any).name).trim() : "";
      if (!name) continue;
      const description = typeof (fdObj as any).description === "string" ? String((fdObj as any).description) : "";
      const parameters = isPlainObject((fdObj as any).parameters) ? (fdObj as any).parameters : { type: "object", properties: {} };
      out.push({ type: "function", function: { name, description, parameters } });
    }
  }
  return out;
}

export function geminiRequestToOpenAIChat(reqJson: unknown): Record<string, unknown> {
  const body = isPlainObject(reqJson) ? reqJson : {};
  const contents = Array.isArray((body as any).contents) ? ((body as any).contents as unknown[]) : [];
  const systemInstruction = isPlainObject((body as any).systemInstruction) ? ((body as any).systemInstruction as Record<string, unknown>) : null;

  const messages: Array<{ role: string; content: unknown }> = [];
  if (systemInstruction) {
    const parts = Array.isArray((systemInstruction as any).parts) ? ((systemInstruction as any).parts as unknown[]) : [];
    const sysText = parts
      .map((p) => (p && typeof p === "object" && typeof (p as any).text === "string" ? String((p as any).text) : ""))
      .join("");
    if (sysText.trim()) messages.push({ role: "system", content: sysText.trim() });
  }

  for (const c of contents) {
    if (!c || typeof c !== "object") continue;
    const cObj = c as Record<string, unknown>;
    const role = (cObj as any).role === "model" ? "assistant" : "user";
    const content = geminiPartsToOpenAiContent((cObj as any).parts);
    messages.push({ role, content });
  }

  const tools = geminiToolsToOpenAiTools((body as any).tools);

  const generationConfig = isPlainObject((body as any).generationConfig) ? (body as any).generationConfig : {};
  const maxOutputTokens = (generationConfig as any).maxOutputTokens;
  const temperature = (generationConfig as any).temperature;
  const topP = (generationConfig as any).topP;

  return {
    model: "",
    messages,
    tools: tools.length ? tools : undefined,
    stream: false,
    max_tokens: maxOutputTokens,
    temperature,
    top_p: topP,
  };
}

export function openAIChatResponseToGemini(chatJson: unknown): Record<string, unknown> {
  const chatObj = chatJson && typeof chatJson === "object" ? (chatJson as Record<string, unknown>) : {};
  const choices = Array.isArray((chatObj as any).choices) ? ((chatObj as any).choices as unknown[]) : [];
  const choice0 = choices.length ? (choices[0] as any) : null;
  const msg = choice0 && typeof choice0.message === "object" ? (choice0.message as Record<string, unknown>) : null;
  const text = msg ? normalizeMessageContent((msg as any).content) : "";
  const finishReason = choice0 && typeof choice0.finish_reason === "string" && choice0.finish_reason.trim() ? choice0.finish_reason : "STOP";

  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: text || "" }],
        },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata:
      (chatObj as any).usage && typeof (chatObj as any).usage === "object"
        ? {
            promptTokenCount: Number((chatObj as any).usage.prompt_tokens ?? 0) || 0,
            candidatesTokenCount: Number((chatObj as any).usage.completion_tokens ?? 0) || 0,
            totalTokenCount: Number((chatObj as any).usage.total_tokens ?? 0) || 0,
          }
        : undefined,
  };
}

