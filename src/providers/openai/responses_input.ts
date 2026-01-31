import { normalizeMessageContent, normalizeToolCallsFromChatMessage } from "../../common";

export function messageContentToResponsesParts(content: any): any[] {
  const out: any[] = [];

  const normalizeMimeType = (v: unknown) => {
    if (typeof v !== "string") return "";
    const mt = v.trim();
    return mt;
  };

  const getMimeType = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return "";
    const rec = obj as any;
    return normalizeMimeType(rec.mime_type) || normalizeMimeType(rec.mimeType) || normalizeMimeType(rec.media_type) || normalizeMimeType(rec.mediaType);
  };

  const isProbablyBase64 = (raw: unknown) => {
    if (typeof raw !== "string") return false;
    const s = raw.trim();
    if (!s) return false;
    if (s.startsWith("data:")) return false;
    if (/^https?:\/\//i.test(s)) return false;
    // Remove whitespace/newlines (common when base64 is wrapped).
    const cleaned = s.replace(/\s+/g, "");
    if (cleaned.length < 40) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return false;
    return true;
  };

  const pushText = (text: unknown) => {
    if (typeof text !== "string") return;
    if (!text) return;
    out.push({ type: "input_text", text });
  };

  const pushImageUrl = (value: unknown, mimeType: unknown) => {
    if (typeof value !== "string") return;
    let v = value.trim();
    if (!v) return;
    if (isProbablyBase64(v)) {
      const cleaned = v.replace(/\s+/g, "");
      const mt = normalizeMimeType(mimeType) || "image/png";
      v = `data:${mt};base64,${cleaned}`;
    }
    out.push({ type: "input_image", image_url: v });
  };

  const handlePart = (part: any) => {
    if (part == null) return;
    if (typeof part === "string") {
      pushText(part);
      return;
    }
    if (typeof part !== "object") {
      pushText(String(part));
      return;
    }

    const t = part.type;

    if (t === "text" || t === "input_text" || t === "output_text") {
      if (typeof part.text === "string") pushText(part.text);
      return;
    }

    if (t === "image_url" || t === "input_image" || t === "image") {
      const mimeType = getMimeType(part);
      const v = part.image_url ?? part.url ?? part.image;
      if (typeof v === "string") pushImageUrl(v, mimeType);
      else if (v && typeof v === "object") {
        const nestedMimeType = getMimeType(v) || mimeType;
        if (typeof (v as any).url === "string") pushImageUrl((v as any).url, nestedMimeType);
        else {
          const b64 = (v as any).base64 ?? (v as any).b64 ?? (v as any).b64_json ?? (v as any).data ?? (v as any).image_base64 ?? (v as any).imageBase64;
          if (typeof b64 === "string") pushImageUrl(b64, nestedMimeType);
        }
      }
      return;
    }

    // Handle objects without explicit type (best-effort).
    if ("image_url" in part) {
      const mimeType = getMimeType(part);
      const v = part.image_url;
      if (typeof v === "string") pushImageUrl(v, mimeType);
      else if (v && typeof v === "object") {
        const nestedMimeType = getMimeType(v) || mimeType;
        if (typeof (v as any).url === "string") pushImageUrl((v as any).url, nestedMimeType);
        else {
          const b64 = (v as any).base64 ?? (v as any).b64 ?? (v as any).b64_json ?? (v as any).data ?? (v as any).image_base64 ?? (v as any).imageBase64;
          if (typeof b64 === "string") pushImageUrl(b64, nestedMimeType);
        }
      }
      return;
    }
    if (typeof part.text === "string") {
      pushText(part.text);
      return;
    }
  };

  if (Array.isArray(content)) {
    for (const item of content) handlePart(item);
    return out;
  }

  handlePart(content);
  return out;
}

export function openaiToolsToResponsesTools(tools: any): any[] {
  const list = Array.isArray(tools) ? tools : [];
  const out: any[] = [];

  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const type = (t as any).type;

    // Pass through non-function tools (Responses supports some native tool types).
    if (type !== "function") {
      out.push(t);
      continue;
    }

    // Accept both shapes:
    // - Chat Completions: { type:"function", function:{ name, description, parameters } }
    // - Responses:       { type:"function", name, description, parameters }
    const fn = (t as any).function && typeof (t as any).function === "object" ? (t as any).function : null;
    const nameRaw = typeof (t as any).name === "string" ? (t as any).name : fn && typeof fn.name === "string" ? fn.name : "";
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!name) continue;

    const description = typeof (t as any).description === "string" ? (t as any).description : fn && typeof fn.description === "string" ? fn.description : "";
    const parameters =
      (t as any).parameters && typeof (t as any).parameters === "object"
        ? (t as any).parameters
        : fn && fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : null;

    const tool: any = { type: "function", name };
    if (typeof description === "string" && description.trim()) tool.description = description;
    if (parameters) tool.parameters = parameters;
    out.push(tool);
  }

  return out;
}

export function openaiToolChoiceToResponsesToolChoice(toolChoice: any): any {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice !== "object") return undefined;

  const type = toolChoice.type;
  if (type !== "function") return toolChoice;

  const nameRaw =
    typeof toolChoice.name === "string"
      ? toolChoice.name
      : toolChoice.function && typeof toolChoice.function === "object" && typeof toolChoice.function.name === "string"
        ? toolChoice.function.name
        : "";
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return toolChoice;

  return { type: "function", name };
}

export function chatMessagesToResponsesInput(messages: any): { instructions: string | null; input: any[] } {
  const instructionsParts: string[] = [];
  const inputItems: any[] = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    let role = (msg as any).role || "user";

    if (role === "system" || role === "developer") {
      let contentText = normalizeMessageContent((msg as any).content);
      if (!contentText.trim()) {
        const reasoning = (msg as any).reasoning_content;
        if (typeof reasoning === "string" && reasoning.trim()) contentText = reasoning;
      }
      if (contentText.trim()) instructionsParts.push(contentText);
      continue;
    }

    if (role === "tool") {
      const callIdRaw = (msg as any).tool_call_id ?? (msg as any).toolCallId ?? (msg as any).call_id ?? (msg as any).callId ?? (msg as any).id;
      const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
      const output = normalizeMessageContent((msg as any).content);
      if (!callId) continue;
      inputItems.push({ type: "function_call_output", call_id: callId, output: output ?? "" });
      continue;
    }

    if (role === "assistant") {
      const text = normalizeMessageContent((msg as any).content);
      if (typeof text === "string" && text.trim()) {
        inputItems.push({ role: "assistant", content: text });
      } else {
        const reasoning = (msg as any).reasoning_content;
        if (typeof reasoning === "string" && reasoning.trim()) {
          inputItems.push({ role: "assistant", content: reasoning });
        }
      }

      const calls = normalizeToolCallsFromChatMessage(msg);
      for (const c of calls) {
        const fcItem: any = {
          type: "function_call",
          id: `fc_${c.call_id}`,
          call_id: c.call_id,
          name: c.name,
          arguments: c.arguments,
        };
        if (c.thought_signature) {
          fcItem.thought_signature = c.thought_signature;
        }
        if (c.thought) {
          fcItem.thought = c.thought;
        }
        inputItems.push(fcItem);
      }
      continue;
    }

    if (role !== "user") role = "user";
    let contentParts = messageContentToResponsesParts((msg as any).content);
    if (!contentParts.length) {
      const reasoning = (msg as any).reasoning_content;
      if (typeof reasoning === "string" && reasoning.trim()) {
        contentParts = [{ type: "input_text", text: reasoning }];
      } else {
        continue;
      }
    }
    inputItems.push({ role, content: contentParts });
  }

  const instructions = instructionsParts
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return { instructions: instructions || null, input: inputItems };
}

