import { joinPathPrefix, normalizeBaseUrl, normalizeMessageContent } from "../../common";

export function normalizeClaudeModelId(modelId: unknown, env: any): string {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return env?.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-5-20250929";

  const lower = raw.toLowerCase();
  if (lower === "claude" || lower === "claude-default") {
    const dm = typeof env?.CLAUDE_DEFAULT_MODEL === "string" ? env.CLAUDE_DEFAULT_MODEL.trim() : "";
    return dm || "claude-sonnet-4-5-20250929";
  }

  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

export function buildClaudeMessagesUrls(rawBase: unknown, messagesPathRaw: unknown): string[] {
  const value = String(rawBase ?? "").trim();
  if (!value) return [];

  const configuredPath = String(messagesPathRaw ?? "").trim();

  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);

  const out: string[] = [];
  const pushUrl = (urlStr: unknown) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferMessagesPath = (basePath: string) => {
    const p = (basePath || "").replace(/\/+$/, "");
    if (p.endsWith("/v1")) return "/messages";
    return "/v1/messages";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const isFullEndpoint = basePath.endsWith("/v1/messages") || basePath.endsWith("/messages");

      if (isFullEndpoint) {
        u0.pathname = basePath;
        u0.search = "";
        u0.hash = "";
        pushUrl(u0.toString());
        continue;
      }

      const preferred = configuredPath ? (configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`) : inferMessagesPath(basePath);

      const candidates = [joinPathPrefix(basePath, preferred)];

      for (const path of candidates) {
        const u = new URL(normalized);
        u.pathname = path;
        u.search = "";
        u.hash = "";
        pushUrl(u.toString());
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  return out;
}

export function openaiChatToClaudeMessages(messages: any[]): { messages: any[]; system: any[] | undefined } {
  const claudeMessages: any[] = [];
  let systemText = "";

  for (const msg of messages) {
    const role = msg.role;
    if (role === "system") {
      const txt = normalizeMessageContent(msg.content);
      systemText += (systemText ? "\n\n" : "") + txt;
      continue;
    }

    // Handle tool result messages: group consecutive tool results into one Claude `user` message
    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };

      const last = claudeMessages.length ? claudeMessages[claudeMessages.length - 1] : null;
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((p: any) => p && typeof p === "object" && p.type === "tool_result")) {
        last.content.push(toolResult);
      } else {
        claudeMessages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    const claudeRole = role === "assistant" ? "assistant" : "user";
    const content: any[] = [];

    if (typeof msg.content === "string") {
      content.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") {
          content.push({ type: "text", text: part });
        } else if (part.type === "text") {
          content.push({ type: "text", text: part.text || "" });
        } else if (part.type === "image_url" && part.image_url?.url) {
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
            }
          }
        }
      }
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function" && tc.function) {
          let inputObj = {};
          try {
            inputObj = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: inputObj });
        }
      }
    }

    if (content.length) {
      claudeMessages.push({ role: claudeRole, content });
    }
  }

  const system = systemText.trim();
  return {
    messages: claudeMessages,
    system: system ? [{ type: "text", text: system }] : undefined,
  };
}

export function openaiToolsToClaude(tools: any): any[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

export function claudeStopReasonToOpenai(stopReason: unknown): string {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

export function claudeUsageToOpenaiUsage(usage: any): any {
  return {
    prompt_tokens: usage?.input_tokens || 0,
    completion_tokens: usage?.output_tokens || 0,
    total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
  };
}

export function claudeExtractTextAndToolCalls(content: any): { text: string; toolCalls: any[] } {
  let text = "";
  const toolCalls: any[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        text += block.text || "";
      } else if (block.type === "thinking") {
        // Include thinking in response if present
        if (block.thinking) {
          text += (text ? "\n\n" : "") + "<think>\n" + block.thinking + "\n</think>";
        }
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
  }

  return { text, toolCalls };
}
