/**
 * rsp4copilot on Cloudflare Workers
 * - Inbound: OpenAI-compatible `/v1/chat/completions`, `/v1/completions`, `/v1/models`
 * - Upstream: OpenAI Responses API (`/v1/responses`), streamed SSE
 * - Multi-turn: remembers `previous_response_id` in cache (best-effort)
 * - Vision: supports `image_url` parts -> Responses `input_image`
 *
 * Env vars (Wrangler):
 * - OPENAI_BASE_URL (upstream base URL or full Responses endpoint URL; can be comma-separated for fallback)
 * - RESP_RESPONSES_PATH (optional, defaults to "/v1/responses"; appended when OPENAI_BASE_URL is a base URL)
 * - RESP_REASONING_EFFORT (optional, e.g. "low" | "medium" | "high"; default: unset)
 * - OPENAI_API_KEY (upstream API key)
 * - GEMINI_BASE_URL (optional, Gemini API base URL for Gemini models, e.g. "https://example.com/gemini")
 * - GEMINI_API_KEY (optional, Gemini upstream API key)
 * - GEMINI_DEFAULT_MODEL (optional, default: "gemini-3-pro-preview")
 * - WORKER_AUTH_KEY (client auth key for this Worker)
 * - WORKER_AUTH_KEYS (optional, comma-separated; allows multiple client auth keys)
 * - DEFAULT_MODEL (optional)
 * - MODELS or ADAPTER_MODELS (optional, comma-separated)
 * - RSP4COPILOT_DEBUG (optional, "true"/"1" enables verbose debug logs)
 */

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonError(message, code = "bad_request") {
  return { error: { message, type: "invalid_request_error", code } };
}

function parseBoolEnv(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!v) return false;
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function isDebugEnabled(env) {
  return parseBoolEnv(typeof env?.RSP4COPILOT_DEBUG === "string" ? env.RSP4COPILOT_DEBUG : "");
}

function maskSecret(value) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!v) return "";
  const s = v.trim();
  if (!s) return "";
  if (s.length <= 8) return `${"*".repeat(s.length)} (len=${s.length})`;
  return `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
}

function previewString(value, maxLen = 1200) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!v) return "";
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen)}…(truncated,len=${v.length})`;
}

function redactHeadersForLog(headers) {
  const out = {};
  const h = headers && typeof headers === "object" ? headers : {};
  for (const [k, v] of Object.entries(h)) {
    const key = String(k || "");
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower.includes("api-key") || lower.includes("token") || lower.includes("secret")) {
      out[key] = maskSecret(v);
      continue;
    }
    out[key] = typeof v === "string" ? previewString(v, 200) : v;
  }
  return out;
}

function safeJsonStringifyForLog(value, maxStringLen = 800) {
  const seen = new WeakSet();
  const isSensitiveKey = (keyLower) =>
    keyLower === "authorization" ||
    keyLower.includes("api_key") ||
    keyLower.endsWith("api-key") ||
    keyLower.endsWith("_key") ||
    keyLower.endsWith("key") ||
    keyLower.includes("token") ||
    keyLower.includes("password") ||
    keyLower.includes("passwd") ||
    keyLower.includes("secret");

  return JSON.stringify(value, (key, v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      return v;
    }
    if (typeof v === "string") {
      const keyLower = String(key || "").toLowerCase();
      if (isSensitiveKey(keyLower)) return maskSecret(v);
      return previewString(v, maxStringLen);
    }
    return v;
  });
}

function logDebug(enabled, reqId, label, data) {
  if (!enabled) return;
  const prefix = reqId ? `[rsp4copilot][${reqId}]` : "[rsp4copilot]";
  if (data === undefined) {
    console.log(`${prefix} ${label}`);
  } else {
    console.log(`${prefix} ${label}`, data);
  }
}

function getWorkerAuthKeys(env) {
  const keys = new Set();

  const single = normalizeAuthValue(env?.WORKER_AUTH_KEY);
  if (single) keys.add(single);

  const multiRaw = typeof env?.WORKER_AUTH_KEYS === "string" ? env.WORKER_AUTH_KEYS : "";
  for (const part of String(multiRaw || "").split(",")) {
    const k = normalizeAuthValue(part);
    if (k) keys.add(k);
  }

  return Array.from(keys);
}

function bearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const value = headerValue.trim();
  if (value.toLowerCase().startsWith("bearer ")) return value.slice(7).trim();
  return null;
}

function normalizeBaseUrl(raw) {
  const base = (raw || "").trim();
  if (!base) return base;
  const lower = base.toLowerCase();
  if (lower === "http" || lower === "http:" || lower === "https" || lower === "https:") return "";
  if (base.startsWith("http://") || base.startsWith("https://")) return base;
  return `https://${base}`;
}

function joinPathPrefix(prefixPath, suffixPath) {
  const p = (prefixPath || "").replace(/\/+$/, "");
  const s0 = (suffixPath || "").trim();
  const s = s0.startsWith("/") ? s0 : `/${s0}`;
  if (!p || p === "/") return s;
  return `${p}${s}`;
}

function buildUpstreamUrls(raw, responsesPathRaw) {
  const value = (raw || "").trim();
  if (!value) return [];

  const configuredResponsesPath = (responsesPathRaw || "").trim();

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  const pushUrl = (urlStr) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferResponsesPath = (basePath) => {
    const p = (basePath || "").replace(/\/+$/, "");
    // If the base already ends with /v1, prefer appending /responses (avoid /v1/v1/responses).
    // Many gateways use an "/openai" prefix that already maps to an upstream "/v1".
    if (p.endsWith("/openai") || p.endsWith("/openai/v1")) return "/responses";
    if (p.endsWith("/v1")) return "/responses";
    return "/v1/responses";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const isFullEndpoint = basePath.endsWith("/v1/responses") || basePath.endsWith("/responses");

      if (isFullEndpoint) {
        u0.pathname = basePath;
        u0.search = "";
        u0.hash = "";
        pushUrl(u0.toString());
        continue;
      }

      // Treat as base/prefix: append responses path.
      const preferred = configuredResponsesPath ? (configuredResponsesPath.startsWith("/") ? configuredResponsesPath : `/${configuredResponsesPath}`) : inferResponsesPath(basePath);
      const candidates = [
        joinPathPrefix(basePath, preferred),
        joinPathPrefix(basePath, "/v1/responses"),
        joinPathPrefix(basePath, "/responses"),
      ];

      for (const path of candidates) {
        const u = new URL(normalized);
        u.pathname = path;
        u.search = "";
        u.hash = "";
        pushUrl(u.toString());
      }
    } catch {
      // Ignore invalid URLs; caller will handle empty list.
    }
  }

  return out;
}

function isGeminiModelId(modelId) {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "gemini") return true;
  if (v === "gemini-default") return true;
  if (v.startsWith("gemini-")) return true;
  if (v.includes("/gemini")) return true;
  if (v.includes("gemini-")) return true;
  return false;
}

function isClaudeModelId(modelId) {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "claude") return true;
  if (v === "claude-default") return true;
  if (v.startsWith("claude-")) return true;
  if (v.includes("/claude")) return true;
  if (v.includes("claude-")) return true;
  return false;
}

function applyTemperatureTopPFromRequest(reqJson, target) {
  if (!reqJson || typeof reqJson !== "object") return;
  if (!target || typeof target !== "object") return;

  // Some relays reject requests that specify both temperature and top_p.
  // Prefer temperature when both are present (Copilot often sends both).
  const hasTemp = Object.prototype.hasOwnProperty.call(reqJson, "temperature");
  const hasTopP = Object.prototype.hasOwnProperty.call(reqJson, "top_p");

  if (hasTemp && hasTopP) {
    const temp = reqJson.temperature;
    const topP = reqJson.top_p;
    if ((temp == null || temp === "") && topP != null && topP !== "") {
      target.top_p = topP;
    } else {
      target.temperature = temp;
    }
    return;
  }

  if (hasTemp) target.temperature = reqJson.temperature;
  if (hasTopP) target.top_p = reqJson.top_p;
}

function normalizeClaudeModelId(modelId, env) {
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

function normalizeGeminiModelId(modelId, env) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return env?.GEMINI_DEFAULT_MODEL || "gemini-3-pro-preview";

  const lower = raw.toLowerCase();
  if (lower === "gemini" || lower === "gemini-default") {
    const dm = typeof env?.GEMINI_DEFAULT_MODEL === "string" ? env.GEMINI_DEFAULT_MODEL.trim() : "";
    return dm || "gemini-3-pro-preview";
  }

  // If the model is namespaced (e.g. "google/gemini-2.0-flash"), keep only the last segment.
  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

function normalizeGeminiModelPath(modelId) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return "models/gemini-3-pro-preview";

  // Allow explicit "models/..." or "tunedModels/..."
  if (raw.startsWith("models/") || raw.startsWith("tunedModels/")) return raw;

  // Basic path sanitization (match Google SDK's restrictions).
  if (raw.includes("..") || raw.includes("?") || raw.includes("&")) return "";

  return `models/${raw}`;
}

function buildGeminiGenerateContentUrl(rawBase, modelId, stream) {
  const value = (rawBase || "").trim();
  if (!value) return "";
  try {
    const normalized = normalizeBaseUrl(value);
    const u0 = new URL(normalized);
    let basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";

    // If configured as a full endpoint, keep it (just switch method based on stream).
    if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
      const method = stream ? "streamGenerateContent" : "generateContent";
      u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
      u0.search = "";
      u0.hash = "";
      if (stream) u0.searchParams.set("alt", "sse");
      return u0.toString();
    }

    const modelPath = normalizeGeminiModelPath(modelId);
    if (!modelPath) return "";

    // If base already contains a version segment, don't append again.
    if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
      basePath = joinPathPrefix(basePath, "/v1beta");
    }

    const method = stream ? "streamGenerateContent" : "generateContent";
    u0.pathname = joinPathPrefix(basePath, `/${modelPath}:${method}`);
    u0.search = "";
    u0.hash = "";
    if (stream) {
      u0.searchParams.set("alt", "sse");
    }
    return u0.toString();
  } catch {
    return "";
  }
}

function buildClaudeMessagesUrls(rawBase, messagesPathRaw) {
  const value = (rawBase || "").trim();
  if (!value) return [];

  const configuredPath = (messagesPathRaw || "").trim();

  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);

  const out = [];
  const pushUrl = (urlStr) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferMessagesPath = (basePath) => {
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

      const preferred = configuredPath
        ? configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`
        : inferMessagesPath(basePath);

      const candidates = configuredPath
        ? [joinPathPrefix(basePath, preferred)]
        : [joinPathPrefix(basePath, "/v1/messages")];

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

function openaiChatToClaudeMessages(messages) {
  const claudeMessages = [];
  let systemText = "";

  for (const msg of messages) {
    const role = msg.role;
    if (role === "system") {
      const txt = normalizeMessageContent(msg.content);
      systemText += (systemText ? "\n\n" : "") + txt;
      continue;
    }

    // Handle tool result messages separately
    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
      };
      claudeMessages.push({ role: "user", content: [toolResult] });
      continue;
    }

    const claudeRole = role === "assistant" ? "assistant" : "user";
    const content = [];

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
          try { inputObj = JSON.parse(tc.function.arguments || "{}"); } catch {}
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

function openaiToolsToClaude(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((t) => t.type === "function" && t.function).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

function claudeStopReasonToOpenai(stopReason) {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function claudeUsageToOpenaiUsage(usage) {
  return {
    prompt_tokens: usage?.input_tokens || 0,
    completion_tokens: usage?.output_tokens || 0,
    total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
  };
}

function claudeExtractTextAndToolCalls(content) {
  let text = "";
  const toolCalls = [];

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

function normalizeMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const t = item.type;
        if (t === "text" || t === "input_text" || t === "output_text") {
          if (typeof item.text === "string") parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string")
    return content.text;
  return String(content);
}

function messageContentToResponsesParts(content) {
  const out = [];

  const normalizeMimeType = (v) => {
    if (typeof v !== "string") return "";
    const mt = v.trim();
    return mt;
  };

  const getMimeType = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    return (
      normalizeMimeType(obj.mime_type) ||
      normalizeMimeType(obj.mimeType) ||
      normalizeMimeType(obj.media_type) ||
      normalizeMimeType(obj.mediaType)
    );
  };

  const isProbablyBase64 = (raw) => {
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

  const pushText = (text) => {
    if (typeof text !== "string") return;
    if (!text) return;
    out.push({ type: "input_text", text });
  };

  const pushImageUrl = (value, mimeType) => {
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

  const handlePart = (part) => {
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
        if (typeof v.url === "string") pushImageUrl(v.url, nestedMimeType);
        else {
          const b64 = v.base64 ?? v.b64 ?? v.b64_json ?? v.data ?? v.image_base64 ?? v.imageBase64;
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
        if (typeof v.url === "string") pushImageUrl(v.url, nestedMimeType);
        else {
          const b64 = v.base64 ?? v.b64 ?? v.b64_json ?? v.data ?? v.image_base64 ?? v.imageBase64;
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

function normalizeToolCallsFromChatMessage(msg) {
  const out = [];
  if (!msg || typeof msg !== "object") return out;

  const pushToolCall = (id, name, args, thoughtSignature, thought) => {
    const callId = typeof id === "string" && id.trim() ? id.trim() : `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const toolName = typeof name === "string" && name.trim() ? name.trim() : "";
    if (!toolName) return;
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
    const item = { call_id: callId, name: toolName, arguments: argStr };
    // Preserve thought_signature and thought for Gemini thinking models (2025 API)
    if (typeof thoughtSignature === "string" && thoughtSignature.trim()) {
      item.thought_signature = thoughtSignature.trim();
    }
    if (typeof thought === "string") {
      item.thought = thought;
    }
    out.push(item);
  };

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const id = typeof tc.id === "string" ? tc.id : "";
    const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
    const name = fn && typeof fn.name === "string" ? fn.name : "";
    const args = fn ? fn.arguments : undefined;
    // Extract thought_signature and thought from tool call (may be at tc level or fn level)
    const thoughtSignature = tc.thought_signature ?? tc.thoughtSignature ?? fn?.thought_signature ?? fn?.thoughtSignature ?? "";
    const thought = tc.thought ?? tc.reasoning ?? fn?.thought ?? fn?.reasoning ?? "";
    pushToolCall(id, name, args, thoughtSignature, thought);
  }

  // Legacy: assistant.function_call
  const fc = msg.function_call && typeof msg.function_call === "object" ? msg.function_call : null;
  if (fc) {
    const name = typeof fc.name === "string" ? fc.name : "";
    const args = "arguments" in fc ? fc.arguments : undefined;
    const thoughtSignature = fc.thought_signature ?? fc.thoughtSignature ?? "";
    const thought = fc.thought ?? fc.reasoning ?? "";
    pushToolCall(msg.tool_call_id || msg.id || "", name, args, thoughtSignature, thought);
  }

  return out;
}

function openaiToolsToResponsesTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];

  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const type = t.type;

    // Pass through non-function tools (Responses supports some native tool types).
    if (type !== "function") {
      out.push(t);
      continue;
    }

    // Accept both shapes:
    // - Chat Completions: { type:"function", function:{ name, description, parameters } }
    // - Responses:       { type:"function", name, description, parameters }
    const fn = t.function && typeof t.function === "object" ? t.function : null;
    const nameRaw = typeof t.name === "string" ? t.name : fn && typeof fn.name === "string" ? fn.name : "";
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (!name) continue;

    const description =
      typeof t.description === "string" ? t.description : fn && typeof fn.description === "string" ? fn.description : "";
    const parameters =
      t.parameters && typeof t.parameters === "object"
        ? t.parameters
        : fn && fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : null;

    const tool = { type: "function", name };
    if (typeof description === "string" && description.trim()) tool.description = description;
    if (parameters) tool.parameters = parameters;
    out.push(tool);
  }

  return out;
}

function openaiToolChoiceToResponsesToolChoice(toolChoice) {
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

function chatMessagesToResponsesInput(messages) {
  const instructionsParts = [];
  const inputItems = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    let role = msg.role || "user";

    if (role === "system" || role === "developer") {
      let contentText = normalizeMessageContent(msg.content);
      if (!contentText.trim()) {
        const reasoning = msg.reasoning_content;
        if (typeof reasoning === "string" && reasoning.trim()) contentText = reasoning;
      }
      if (contentText.trim()) instructionsParts.push(contentText);
      continue;
    }

    if (role === "tool") {
      const callIdRaw = msg.tool_call_id ?? msg.toolCallId ?? msg.call_id ?? msg.callId ?? msg.id;
      const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
      const output = normalizeMessageContent(msg.content);
      if (!callId) continue;
      inputItems.push({ type: "function_call_output", call_id: callId, output: output ?? "" });
      continue;
    }

    if (role === "assistant") {
      const text = normalizeMessageContent(msg.content);
      if (typeof text === "string" && text.trim()) {
        inputItems.push({ role: "assistant", content: text });
      } else {
        const reasoning = msg.reasoning_content;
        if (typeof reasoning === "string" && reasoning.trim()) {
          inputItems.push({ role: "assistant", content: reasoning });
        }
      }

      const calls = normalizeToolCallsFromChatMessage(msg);
      for (const c of calls) {
        const fcItem = {
          type: "function_call",
          id: `fc_${c.call_id}`,
          call_id: c.call_id,
          name: c.name,
          arguments: c.arguments,
        };
        // Include thought_signature for Gemini thinking models (2025 API)
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
    let contentParts = messageContentToResponsesParts(msg.content);
    if (!contentParts.length) {
      const reasoning = msg.reasoning_content;
      if (typeof reasoning === "string" && reasoning.trim()) {
        contentParts = [{ type: "input_text", text: reasoning }];
      } else {
        continue;
      }
    }
    inputItems.push({ role, content: contentParts });
  }

  const instructions = instructionsParts.map((s) => s.trim()).filter(Boolean).join("\n");
  return { instructions: instructions || null, input: inputItems };
}

function shouldRetryUpstream(status) {
  return status === 400 || status === 422;
}

function responsesReqToPrompt(responsesReq) {
  const parts = [];
  if (typeof responsesReq.instructions === "string" && responsesReq.instructions.trim()) {
    parts.push(responsesReq.instructions.trim());
  }
  if (Array.isArray(responsesReq.input)) {
    for (const item of responsesReq.input) {
      if (!item || typeof item !== "object") continue;
      const role = item.role || "user";
      const text = normalizeMessageContent(item.content);
      if (text.trim()) parts.push(`${role}: ${text}`.trim());
    }
  }
  return parts.join("\n").trim();
}

function responsesReqVariants(responsesReq, stream) {
  const variants = [];
  const base = { ...responsesReq, stream: Boolean(stream) };
  variants.push(base);

  const maxOutput = base.max_output_tokens;
  const instructions = base.instructions;
  const input = base.input;
  const containsImages = (() => {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && part.type === "input_image") return true;
      }
    }
    return false;
  })();
  const hasToolItems = (() => {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const t = item.type;
      if (typeof t === "string" && (t === "function_call" || t === "function_call_output")) return true;
    }
    return false;
  })();

  if (Number.isInteger(maxOutput)) {
    const v = { ...base };
    delete v.max_output_tokens;
    v.max_tokens = maxOutput;
    variants.push(v);
  }

  if (typeof instructions === "string" && instructions.trim() && Array.isArray(input)) {
    const v = { ...base };
    delete v.instructions;
    v.input = [{ role: "system", content: [{ type: "input_text", text: instructions }] }, ...input];
    variants.push(v);
    if (Number.isInteger(maxOutput)) {
      const v2 = { ...v };
      delete v2.max_output_tokens;
      v2.max_tokens = maxOutput;
      variants.push(v2);
    }
  }

  if (Array.isArray(input) && !containsImages && !hasToolItems) {
    const stringInput = input
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const role = item.role || "user";
        const txt = normalizeMessageContent(item.content);
        if (!txt || !String(txt).trim()) return null;
        return { role, content: txt };
      })
      .filter(Boolean);

    const v = { ...base, input: stringInput };
    variants.push(v);

    if (typeof instructions === "string" && instructions.trim()) {
      const v2 = { ...v };
      delete v2.instructions;
      v2.input = [{ role: "system", content: instructions }, ...stringInput];
      variants.push(v2);
    }
  }

  const prompt = responsesReqToPrompt(base);
  if (prompt && !containsImages && !hasToolItems) {
    const v = { ...base };
    delete v.instructions;
    v.input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
    variants.push(v);
  }

  // Some gateways expect `input_image.image_url` to be an object like `{ url }`.
  // If we detect images, add compatibility variants that rewrite that field.
  if (containsImages) {
    const imageObjVariants = [];
    for (const v of variants) {
      if (!v || typeof v !== "object" || !Array.isArray(v.input)) continue;
      let changed = false;
      const newInput = v.input.map((item) => {
        if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
        let contentChanged = false;
        const newContent = item.content.map((part) => {
          if (!part || typeof part !== "object" || part.type !== "input_image") return part;
          const iu = part.image_url;
          if (typeof iu === "string") {
            contentChanged = true;
            return { ...part, image_url: { url: iu } };
          }
          return part;
        });
        if (!contentChanged) return item;
        changed = true;
        return { ...item, content: newContent };
      });
      if (changed) imageObjVariants.push({ ...v, input: newInput });
    }
    variants.push(...imageObjVariants);
  }

  // Reasoning effort compatibility:
  // - Some gateways accept `reasoning: { effort }`
  // - Others accept `reasoning_effort: "<effort>"`
  // - If a gateway rejects reasoning params, try a no-reasoning fallback.
  const expanded = [];
  for (const v of variants) {
    expanded.push(v);
    if (!v || typeof v !== "object") continue;
    const objEffort =
      v.reasoning && typeof v.reasoning === "object" && typeof v.reasoning.effort === "string" ? v.reasoning.effort.trim() : "";
    const topEffort = typeof v.reasoning_effort === "string" ? v.reasoning_effort.trim() : "";
    const effort = objEffort || topEffort;
    if (!effort) continue;

    const asTop = { ...v, reasoning_effort: effort };
    delete asTop.reasoning;
    expanded.push(asTop);

    const asObj = { ...v, reasoning: { effort } };
    delete asObj.reasoning_effort;
    expanded.push(asObj);

    const noReasoning = { ...v };
    delete noReasoning.reasoning;
    delete noReasoning.reasoning_effort;
    expanded.push(noReasoning);
  }
  variants.length = 0;
  variants.push(...expanded);

  const seen = new Set();
  const deduped = [];
  for (const v of variants) {
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  return deduped;
}

function safeJsonParse(text) {
  if (typeof text !== "string") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function resolveJsonSchemaRef(ref, rootSchema) {
  const r = typeof ref === "string" ? ref.trim() : "";
  if (!r) return null;
  if (!rootSchema || typeof rootSchema !== "object") return null;
  if (r === "#") return rootSchema;
  if (!r.startsWith("#/")) return null;

  const decode = (token) => token.replace(/~1/g, "/").replace(/~0/g, "~");
  const parts = r
    .slice(2)
    .split("/")
    .map((p) => decode(p));

  let cur = rootSchema;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    if (!(p in cur)) return null;
    cur = cur[p];
  }
  return cur && typeof cur === "object" ? cur : null;
}

function mergeJsonSchemasShallow(base, next) {
  const a = base && typeof base === "object" ? base : {};
  const b = next && typeof next === "object" ? next : {};

  const out = { ...a, ...b };

  const ap = a.properties && typeof a.properties === "object" && !Array.isArray(a.properties) ? a.properties : null;
  const bp = b.properties && typeof b.properties === "object" && !Array.isArray(b.properties) ? b.properties : null;
  if (ap || bp) out.properties = { ...(ap || {}), ...(bp || {}) };

  const ar = Array.isArray(a.required) ? a.required : null;
  const br = Array.isArray(b.required) ? b.required : null;
  if (ar || br) out.required = Array.from(new Set([...(ar || []), ...(br || [])].filter((x) => typeof x === "string" && x)));

  const ad = a.definitions && typeof a.definitions === "object" && !Array.isArray(a.definitions) ? a.definitions : null;
  const bd = b.definitions && typeof b.definitions === "object" && !Array.isArray(b.definitions) ? b.definitions : null;
  if (ad || bd) out.definitions = { ...(ad || {}), ...(bd || {}) };

  const adefs = a.$defs && typeof a.$defs === "object" && !Array.isArray(a.$defs) ? a.$defs : null;
  const bdefs = b.$defs && typeof b.$defs === "object" && !Array.isArray(b.$defs) ? b.$defs : null;
  if (adefs || bdefs) out.$defs = { ...(adefs || {}), ...(bdefs || {}) };

  return out;
}

function jsonSchemaToGeminiSchema(jsonSchema, rootSchema, refStack) {
  if (!jsonSchema || typeof jsonSchema !== "object") return {};

  const root = rootSchema && typeof rootSchema === "object" ? rootSchema : jsonSchema;
  const stack = refStack instanceof Set ? refStack : new Set();

  const ref = typeof jsonSchema.$ref === "string" ? jsonSchema.$ref.trim() : "";
  if (ref) {
    if (stack.has(ref)) return {};
    stack.add(ref);
    const resolved = resolveJsonSchemaRef(ref, root);
    const merged = resolved && typeof resolved === "object" ? { ...resolved, ...jsonSchema } : { ...jsonSchema };
    delete merged.$ref;
    const out = jsonSchemaToGeminiSchema(merged, root, stack);
    stack.delete(ref);
    return out;
  }

  const allOf = Array.isArray(jsonSchema.allOf) ? jsonSchema.allOf : null;
  if (allOf && allOf.length) {
    let merged = { ...jsonSchema };
    delete merged.allOf;
    for (const it of allOf) {
      if (!it || typeof it !== "object") continue;
      merged = mergeJsonSchemasShallow(merged, it);
    }
    return jsonSchemaToGeminiSchema(merged, root, stack);
  }

  const schemaFieldNames = new Set(["items"]);
  const listSchemaFieldNames = new Set(["anyOf", "oneOf"]);
  const dictSchemaFieldNames = new Set(["properties"]);

  const out = {};

  const input = { ...jsonSchema };

  if (input.type && input.anyOf) {
    // Avoid producing an invalid schema.
    delete input.anyOf;
  }

  // Handle nullable unions like { anyOf: [{type:'null'}, {...}] }
  const anyOf = Array.isArray(input.anyOf) ? input.anyOf : Array.isArray(input.oneOf) ? input.oneOf : null;
  if (anyOf && anyOf.length === 2) {
    const a0 = anyOf[0] && typeof anyOf[0] === "object" ? anyOf[0] : null;
    const a1 = anyOf[1] && typeof anyOf[1] === "object" ? anyOf[1] : null;
    if (a0?.type === "null") {
      out.nullable = true;
      return { ...out, ...jsonSchemaToGeminiSchema(a1, root, stack) };
    }
    if (a1?.type === "null") {
      out.nullable = true;
      return { ...out, ...jsonSchemaToGeminiSchema(a0, root, stack) };
    }
  }

  if (Array.isArray(input.type)) {
    const list = input.type.filter((t) => typeof t === "string");
    if (list.length) {
      out.anyOf = list
        .filter((t) => t !== "null")
        .map((t) => jsonSchemaToGeminiSchema({ ...input, type: t, anyOf: undefined, oneOf: undefined }, root, stack));
      if (list.includes("null")) out.nullable = true;
      delete out.type;
      return out;
    }
  }

  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    if (k.startsWith("$")) continue;
    if (k === "additionalProperties") continue;
    if (k === "definitions") continue;
    if (k === "$defs") continue;
    if (k === "title") continue;
    if (k === "examples") continue;
    if (k === "default") continue;
    if (k === "allOf") continue;

    if (k === "type") {
      if (typeof v !== "string") continue;
      if (v === "null") continue;
      out.type = String(v).toUpperCase();
      continue;
    }

    if (k === "const") {
      if (!("enum" in out)) out.enum = [v];
      continue;
    }

    if (schemaFieldNames.has(k)) {
      if (v && typeof v === "object") out[k] = jsonSchemaToGeminiSchema(v, root, stack);
      continue;
    }

    if (dictSchemaFieldNames.has(k)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const m = {};
        for (const [pk, pv] of Object.entries(v)) {
          if (pv && typeof pv === "object") m[pk] = jsonSchemaToGeminiSchema(pv, root, stack);
        }
        out[k] = m;
      }
      continue;
    }

    if (listSchemaFieldNames.has(k)) {
      if (Array.isArray(v)) {
        const arr = [];
        for (const it of v) {
          if (!it || typeof it !== "object") continue;
          if (it.type === "null") {
            out.nullable = true;
            continue;
          }
          arr.push(jsonSchemaToGeminiSchema(it, root, stack));
        }
        out.anyOf = arr;
      }
      continue;
    }

    // Pass through other supported JSON schema fields (description, enum, required, etc.).
    out[k] = v;
  }

  // Gemini Schema types are enum-like uppercase strings; if absent but properties exist, treat as OBJECT.
  if (!out.type && out.properties && typeof out.properties === "object") out.type = "OBJECT";
  return out;
}

function bytesToBase64(bytes) {
  if (!bytes) return "";
  // Node.js
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // Workers
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function parseDataUrl(dataUrl) {
  const s = typeof dataUrl === "string" ? dataUrl.trim() : "";
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const meta = s.slice(5, comma);
  const data = s.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  const mimeType = meta.replace(/;base64/i, "").trim() || "application/octet-stream";
  if (!isBase64) return null;
  return { mimeType, data: data.replace(/\s+/g, "") };
}

function guessMimeTypeFromUrl(url) {
  const s = typeof url === "string" ? url.toLowerCase() : "";
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  return "";
}

async function openaiImageToGeminiPart(imageValue, mimeTypeHint, fetchFn) {
  const v0 = typeof imageValue === "string" ? imageValue.trim() : "";
  if (!v0) return null;

  const parsed = parseDataUrl(v0);
  if (parsed) {
    return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } };
  }

  const isHttp = /^https?:\/\//i.test(v0);
  const mimeType = (typeof mimeTypeHint === "string" && mimeTypeHint.trim()) || guessMimeTypeFromUrl(v0) || "image/png";

  // Pure base64 (no data: prefix)
  if (!isHttp) {
    const cleaned = v0.replace(/\s+/g, "");
    return { inlineData: { mimeType, data: cleaned } };
  }

  // Fetch remote image and inline it (Gemini API does not accept arbitrary http(s) URLs as image parts).
  const resp = await fetchFn(v0);
  if (!resp.ok) return null;
  const ct = resp.headers.get("content-type") || "";
  const mt = ct.split(";")[0].trim() || mimeType;
  const ab = await resp.arrayBuffer();
  const bytes = new Uint8Array(ab);
  // 8 MiB guardrail
  if (bytes.byteLength > 8 * 1024 * 1024) return null;
  const b64 = bytesToBase64(bytes);
  return { inlineData: { mimeType: mt, data: b64 } };
}

async function openaiContentToGeminiParts(content, fetchFn) {
  const parts = [];
  const pushText = (text) => {
    if (typeof text !== "string") return;
    const t = text;
    if (!t) return;
    parts.push({ text: t });
  };

  const handlePart = async (part) => {
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
    if (t === "text" && typeof part.text === "string") {
      pushText(part.text);
      return;
    }
    if (t === "image_url" || t === "input_image" || t === "image") {
      const mimeType = part.mime_type || part.mimeType || part.media_type || part.mediaType || "";
      const v = part.image_url ?? part.url ?? part.image;
      if (typeof v === "string") {
        const img = await openaiImageToGeminiPart(v, mimeType, fetchFn);
        if (img) parts.push(img);
      } else if (v && typeof v === "object") {
        const url = v.url ?? v.image_url ?? v.image;
        const b64 = v.base64 ?? v.b64 ?? v.b64_json ?? v.data ?? v.image_base64 ?? v.imageBase64;
        if (typeof url === "string") {
          const img = await openaiImageToGeminiPart(url, mimeType, fetchFn);
          if (img) parts.push(img);
        } else if (typeof b64 === "string") {
          const img = await openaiImageToGeminiPart(b64, mimeType, fetchFn);
          if (img) parts.push(img);
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
    for (const item of content) await handlePart(item);
    return parts;
  }
  await handlePart(content);
  return parts;
}

function openaiToolsToGeminiFunctionDeclarations(tools) {
  const out = [];
  const list = Array.isArray(tools) ? tools : [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    if (t.type !== "function") continue;
    const fn = t.function && typeof t.function === "object" ? t.function : null;
    const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const description = fn && typeof fn.description === "string" ? fn.description : undefined;
    const params = fn && fn.parameters && typeof fn.parameters === "object" ? fn.parameters : undefined;
    const decl = { name };
    if (description) decl.description = description;
    if (params) decl.parameters = jsonSchemaToGeminiSchema(params);
    out.push(decl);
  }
  return out;
}

function openaiToolChoiceToGeminiToolConfig(toolChoice) {
  if (toolChoice == null) return null;

  if (typeof toolChoice === "string") {
    const v = toolChoice.trim().toLowerCase();
    if (v === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (v === "required" || v === "any") return { functionCallingConfig: { mode: "ANY" } };
    // default: auto
    return { functionCallingConfig: { mode: "AUTO" } };
  }

  if (typeof toolChoice === "object") {
    const t = toolChoice.type;
    if (t === "function") {
      const name = toolChoice.function && typeof toolChoice.function === "object" ? toolChoice.function.name : "";
      if (typeof name === "string" && name.trim()) {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name.trim()] } };
      }
    }
  }

  return null;
}

async function openaiChatToGeminiRequest(reqJson, env, fetchFn, extraSystemText, thoughtSigCache) {
  const messages = Array.isArray(reqJson?.messages) ? reqJson.messages : [];
  const systemTextParts = [];
  const contents = [];
  const toolNameByCallId = new Map();
  // Cache for looking up thought_signature by call_id
  const sigCache = thoughtSigCache && typeof thoughtSigCache === "object" ? thoughtSigCache : {};

  const toolMessageToFunctionResponsePart = (msg, fallbackName = "") => {
    if (!msg || typeof msg !== "object") return null;
    const callIdRaw = msg.tool_call_id ?? msg.toolCallId ?? msg.call_id ?? msg.callId ?? msg.id;
    const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
    const mappedName = callId ? toolNameByCallId.get(callId) || "" : "";
    const name = mappedName || fallbackName || "";
    if (!name) return null;

    const content = msg.content;
    const raw =
      typeof content === "string"
        ? content
        : content == null
          ? ""
          : (() => {
              try {
                return JSON.stringify(content);
              } catch {
                return String(content);
              }
            })();
    const rawText = typeof raw === "string" ? raw : String(raw ?? "");

    const parsed = safeJsonParse(rawText);
    let responseValue = { output: rawText };
    if (parsed.ok) {
      const v = parsed.value;
      if (v != null && typeof v === "object" && !Array.isArray(v)) responseValue = v;
      else responseValue = { output: v };
    }

    return { callId, part: { functionResponse: { name, response: responseValue } } };
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const roleRaw = typeof msg.role === "string" ? msg.role : "user";

    if (roleRaw === "system" || roleRaw === "developer") {
      const t = normalizeMessageContent(msg.content);
      if (t && String(t).trim()) systemTextParts.push(String(t).trim());
      continue;
    }

    if (roleRaw === "user") {
      const parts = await openaiContentToGeminiParts(msg.content, fetchFn);
      if (parts.length) contents.push({ role: "user", parts });
      continue;
    }

    if (roleRaw === "assistant") {
      const parts = [];
      const txt = normalizeMessageContent(msg.content);
      if (txt && String(txt).trim()) parts.push({ text: String(txt) });

      const calls = normalizeToolCallsFromChatMessage(msg);
      const callOrder = [];
      for (const c of calls) {
        toolNameByCallId.set(c.call_id, c.name);
        callOrder.push({ call_id: c.call_id, name: c.name });
        const parsedArgs = safeJsonParse(c.arguments);
        
        // Try to get thought_signature from message first, then from cache
        let thoughtSig = c.thought_signature || "";
        let thought = c.thought || "";
        if (!thoughtSig && sigCache[c.call_id]) {
          thoughtSig = sigCache[c.call_id].thought_signature || "";
          thought = sigCache[c.call_id].thought || thought;
        }
        
        // Build the functionCall part (2025 API: thoughtSignature is sibling to functionCall in same part)
        const fcPart = {
          functionCall: {
            name: c.name,
            args: parsedArgs.ok && parsedArgs.value && typeof parsedArgs.value === "object" ? parsedArgs.value : { _raw: c.arguments },
          },
        };
        
        // Add thoughtSignature to the same part (camelCase as returned by Gemini)
        if (thoughtSig) {
          fcPart.thoughtSignature = thoughtSig;
        }
        if (thought) {
          fcPart.thought = thought;
        }
        
        parts.push(fcPart);
      }

      if (parts.length) contents.push({ role: "model", parts });

      // Gemini requires that tool responses are provided as a single "user" turn
      // containing the same number of functionResponse parts as the preceding model's functionCall parts.
      if (calls.length) {
        const responsesByCallId = new Map();
        let j = i + 1;
        while (j < messages.length) {
          const m2 = messages[j];
          if (!m2 || typeof m2 !== "object") break;
          const r2 = typeof m2.role === "string" ? m2.role : "";
          if (r2 !== "tool") break;

          const item = toolMessageToFunctionResponsePart(m2);
          if (item && item.callId) responsesByCallId.set(item.callId, item.part);
          j++;
        }

        // Only emit functionResponses if the history actually includes tool messages for this turn.
        if (j > i + 1) {
          const respParts = [];
          for (const c of callOrder) {
            const found = responsesByCallId.get(c.call_id);
            if (found) {
              respParts.push(found);
            } else {
              // Keep the turn structurally valid even if a tool result is missing.
              respParts.push({ functionResponse: { name: c.name, response: { output: "" } } });
            }
          }
          contents.push({ role: "user", parts: respParts });
          i = j - 1; // consume tool messages
        }
      }
      continue;
    }

    if (roleRaw === "tool") {
      // Best-effort: group consecutive tool results into a single turn.
      const respParts = [];
      let j = i;
      while (j < messages.length) {
        const m2 = messages[j];
        if (!m2 || typeof m2 !== "object") break;
        const r2 = typeof m2.role === "string" ? m2.role : "";
        if (r2 !== "tool") break;
        const item = toolMessageToFunctionResponsePart(m2);
        if (item?.part) respParts.push(item.part);
        j++;
      }
      if (respParts.length) contents.push({ role: "user", parts: respParts });
      i = j - 1;
      continue;
    }
  }

  const systemText = appendInstructions(systemTextParts.join("\n").trim(), extraSystemText);
  const generationConfig = {};
  if ("temperature" in reqJson) generationConfig.temperature = reqJson.temperature;
  if ("top_p" in reqJson) generationConfig.topP = reqJson.top_p;
  if ("presence_penalty" in reqJson) generationConfig.presencePenalty = reqJson.presence_penalty;
  if ("frequency_penalty" in reqJson) generationConfig.frequencyPenalty = reqJson.frequency_penalty;

  const maxTokens = Number.isInteger(reqJson.max_tokens)
    ? reqJson.max_tokens
    : Number.isInteger(reqJson.max_completion_tokens)
      ? reqJson.max_completion_tokens
      : null;
  if (Number.isInteger(maxTokens)) generationConfig.maxOutputTokens = maxTokens;

  if ("stop" in reqJson) {
    const st = reqJson.stop;
    if (typeof st === "string" && st) generationConfig.stopSequences = [st];
    else if (Array.isArray(st)) generationConfig.stopSequences = st.filter((x) => typeof x === "string" && x);
  }

  const decls = openaiToolsToGeminiFunctionDeclarations(reqJson.tools);
  const toolConfig = decls.length ? openaiToolChoiceToGeminiToolConfig(reqJson.tool_choice) : null;

  const body = {
    contents,
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(systemText ? { systemInstruction: { role: "user", parts: [{ text: systemText }] } } : {}),
    ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  };

  return body;
}

function geminiArgsToJsonString(args) {
  if (typeof args === "string") return args;
  if (args == null) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function geminiFinishReasonToOpenai(finishReason, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  const v = typeof finishReason === "string" ? finishReason.trim().toLowerCase() : "";
  if (!v) return "stop";
  if (v === "stop") return "stop";
  if (v === "max_tokens" || v === "max_tokens_reached" || v === "length") return "length";
  if (v === "safety" || v === "recitation" || v === "content_filter") return "content_filter";
  return "stop";
}

function geminiUsageToOpenaiUsage(usageMetadata) {
  const u = usageMetadata && typeof usageMetadata === "object" ? usageMetadata : null;
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

function geminiExtractTextAndToolCalls(respJson) {
  const root = respJson && typeof respJson === "object" ? respJson : null;
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const cand = candidates.length ? candidates[0] : null;

  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  
  let text = "";
  const toolCalls = [];
  
  // Track the most recent thought/thought_signature for the next function call (2025 API)
  let pendingThought = "";
  let pendingThoughtSignature = "";

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    
    // Check for functionCall first (2025 API: thoughtSignature is sibling to functionCall in same part)
    const fc = p.functionCall;
    if (fc && typeof fc === "object") {
      const name = typeof fc.name === "string" ? fc.name.trim() : "";
      if (!name) continue;
      const argsStr = geminiArgsToJsonString(fc.args);
      const tcItem = {
        id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: { name, arguments: argsStr && argsStr.trim() ? argsStr : "{}" },
      };
      
      // Extract thought_signature from the same part (2025 API: thoughtSignature is sibling to functionCall)
      const thoughtSig = 
        p.thoughtSignature || p.thought_signature ||
        fc.thoughtSignature || fc.thought_signature ||
        pendingThoughtSignature ||
        "";
      const thought = 
        p.thought ||
        fc.thought ||
        pendingThought ||
        "";
        
      if (typeof thoughtSig === "string" && thoughtSig.trim()) {
        tcItem.thought_signature = thoughtSig.trim();
      }
      if (typeof thought === "string" && thought) {
        tcItem.thought = thought;
      }
      toolCalls.push(tcItem);
      
      // Reset pending thought after consuming
      pendingThought = "";
      pendingThoughtSignature = "";
      continue;
    }
    
    // Handle text parts
    if (typeof p.text === "string" && p.text) {
      text += p.text;
      continue;
    }
    
    // Handle standalone thought parts (if they come separately)
    if (typeof p.thought === "string" || typeof p.thought_signature === "string" || typeof p.thoughtSignature === "string") {
      if (typeof p.thought === "string") pendingThought = p.thought;
      if (typeof p.thought_signature === "string") pendingThoughtSignature = p.thought_signature;
      if (typeof p.thoughtSignature === "string") pendingThoughtSignature = p.thoughtSignature;
      continue;
    }
  }

  const finishReasonRaw = cand?.finishReason ?? cand?.finish_reason;
  const finish_reason = geminiFinishReasonToOpenai(finishReasonRaw, toolCalls.length > 0);
  return { text, toolCalls, finish_reason, usage: geminiUsageToOpenaiUsage(root?.usageMetadata) };
}

function extractOutputTextFromResponsesResponse(response) {
  if (!response || typeof response !== "object") return "";

  const ot = response.output_text;
  if (typeof ot === "string" && ot) return ot;
  if (Array.isArray(ot)) {
    const joined = ot.filter((x) => typeof x === "string").join("");
    if (joined) return joined;
  }

  const parts = [];
  const push = (v) => {
    if (typeof v === "string" && v) parts.push(v);
  };

  const outputs = response.output;
  if (Array.isArray(outputs)) {
    for (const out of outputs) {
      if (!out || typeof out !== "object") continue;
      push(out.text);
      push(out.output_text);
      const content = out.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          push(c.text);
          push(c.output_text);
        }
      }
    }
  }

  const content = response.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      push(c.text);
      push(c.output_text);
    }
  }

  return parts.join("");
}

function extractToolCallsFromResponsesResponse(response) {
  const out = [];
  if (!response || typeof response !== "object") return out;

  const seen = new Set();
  const push = (callIdRaw, nameRaw, argsRaw) => {
    const callId = typeof callIdRaw === "string" && callIdRaw.trim() ? callIdRaw.trim() : "";
    if (!callId || seen.has(callId)) return;
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "";
    const args = typeof argsRaw === "string" ? argsRaw : argsRaw == null ? "" : String(argsRaw);
    out.push({ call_id: callId, name, arguments: args });
    seen.add(callId);
  };

  const visit = (item) => {
    if (!item || typeof item !== "object") return;

    const t = item.type;
    if (typeof t === "string" && t === "function_call") {
      push(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments);
      return;
    }

    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : null;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        push(tc.id, tc.function?.name, tc.function?.arguments);
      }
    }
  };

  const outputs = response.output;
  if (Array.isArray(outputs)) {
    for (const item of outputs) visit(item);
  }

  return out;
}

function extractFromResponsesSseText(sseText) {
  const text0 = typeof sseText === "string" ? sseText : "";
  const lines = text0.split("\n");
  let text = "";
  let responseId = null;
  let model = null;
  let createdAt = null;
  let sawDelta = false;
  let sawAnyText = false;
  const toolCalls = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const evt = payload?.type;

    if (evt === "response.created" && payload?.response && typeof payload.response === "object") {
      const rid = payload.response.id;
      if (typeof rid === "string" && rid) responseId = rid;
      const m = payload.response.model;
      if (typeof m === "string" && m) model = m;
      const c = payload.response.created_at;
      if (Number.isInteger(c)) createdAt = c;
      continue;
    }

    if (evt === "response.function_call_arguments.delta") {
      const callId = payload.call_id ?? payload.callId ?? payload.id;
      const name = payload.name;
      const delta = payload.delta;
      if (typeof callId === "string" && callId.trim()) {
        toolCalls.push({
          call_id: callId.trim(),
          name: typeof name === "string" ? name : "",
          arguments: typeof delta === "string" ? delta : "",
        });
      }
      continue;
    }

    if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string") {
      sawDelta = true;
      sawAnyText = true;
      text += payload.delta;
      continue;
    }
    if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string") {
      sawAnyText = true;
      text += payload.text;
      continue;
    }
    if (evt === "response.completed" && payload?.response && typeof payload.response === "object") {
      const rid = payload.response.id;
      if (!responseId && typeof rid === "string" && rid) responseId = rid;
      if (!sawDelta && !sawAnyText) {
        const t = extractOutputTextFromResponsesResponse(payload.response);
        if (t) {
          sawAnyText = true;
          text += t;
        }
      }
      const calls = extractToolCallsFromResponsesResponse(payload.response);
      for (const c of calls) toolCalls.push(c);
    }
  }

  return { text, responseId, model, createdAt, toolCalls };
}

async function selectUpstreamResponse(upstreamUrl, headers, variants, debug = false, reqId = "") {
  let lastStatus = 502;
  let lastText = "";
  let firstErr = null; // { status, text }
  let exhaustedRetryable = false;
  for (let i = 0; i < variants.length; i++) {
    const body = JSON.stringify(variants[i]);
    if (debug) {
      logDebug(debug, reqId, "openai upstream fetch", {
        url: upstreamUrl,
        variant: i,
        headers: redactHeadersForLog(headers),
        bodyLen: body.length,
        bodyPreview: previewString(body, 1200),
      });
    }
    let resp;
    try {
      const t0 = Date.now();
      resp = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body,
      });
      if (debug) {
        logDebug(debug, reqId, "openai upstream response", {
          url: upstreamUrl,
          variant: i,
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get("content-type") || "",
          elapsedMs: Date.now() - t0,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "fetch failed";
      return { ok: false, status: 502, error: jsonError(`Upstream fetch failed: ${message}`, "bad_gateway"), upstreamUrl };
    }
    if (resp.status >= 400) {
      lastStatus = resp.status;
      lastText = await resp.text().catch(() => "");
      if (!firstErr) firstErr = { status: resp.status, text: lastText };
      if (shouldRetryUpstream(resp.status) && i + 1 < variants.length) continue;
      exhaustedRetryable = shouldRetryUpstream(resp.status) && i + 1 >= variants.length;
      try {
        const errText = exhaustedRetryable && firstErr ? firstErr.text : lastText;
        const errJson = JSON.parse(errText);
        const errStatus = exhaustedRetryable && firstErr ? firstErr.status : resp.status;
        return { ok: false, status: errStatus, error: errJson, upstreamUrl };
      } catch {
        const errStatus = exhaustedRetryable && firstErr ? firstErr.status : resp.status;
        return { ok: false, status: errStatus, error: jsonError(`Upstream error: HTTP ${errStatus}`), upstreamUrl };
      }
    }
    return { ok: true, resp, upstreamUrl };
  }
  if (exhaustedRetryable && firstErr) {
    try {
      return { ok: false, status: firstErr.status, error: JSON.parse(firstErr.text), upstreamUrl };
    } catch {
      return { ok: false, status: firstErr.status, error: jsonError(firstErr.text || `Upstream error: HTTP ${firstErr.status}`), upstreamUrl };
    }
  }
  return { ok: false, status: lastStatus, error: jsonError(lastText || `Upstream error: HTTP ${lastStatus}`), upstreamUrl };
}

function shouldTryNextUpstreamUrl(status) {
  // Gateways often return 403/404/405 for wrong paths; 502 for network/DNS.
  // Some gateways also return 400/422 for unhandled routes.
  return (
    status === 400 ||
    status === 422 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 500 ||
    status === 502 ||
    status === 503
  );
}

async function isProbablyEmptyEventStream(resp) {
  try {
    const ct = (resp?.headers?.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream")) return false;
    if (!resp?.body) return true;

    const clone = resp.clone();
    const reader = clone.body.getReader();

    const timeoutMs = 50;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const first = await Promise.race([reader.read(), timeout]);
    try {
      await reader.cancel();
    } catch {}

    // If it hasn't produced anything quickly, assume it's not empty (could just be slow model output).
    if (!first) return false;

    const { done, value } = first;
    if (done) return true;
    if (!value || value.length === 0) return true;
    return false;
  } catch {
    return false;
  }
}

async function selectUpstreamResponseAny(upstreamUrls, headers, variants, debug = false, reqId = "") {
  const urls = Array.isArray(upstreamUrls) ? upstreamUrls.filter(Boolean) : [];
  if (!urls.length) {
    return { ok: false, status: 500, error: jsonError("Server misconfigured: empty upstream URL list", "server_error") };
  }

  let firstErr = null;
  for (const url of urls) {
    if (debug) logDebug(debug, reqId, "openai upstream try", { url });
    const sel = await selectUpstreamResponse(url, headers, variants, debug, reqId);
    if (debug && !sel.ok) {
      logDebug(debug, reqId, "openai upstream try failed", {
        upstreamUrl: sel.upstreamUrl,
        status: sel.status,
        error: sel.error,
      });
    }
    if (sel.ok && (await isProbablyEmptyEventStream(sel.resp))) {
      if (!firstErr) {
        firstErr = {
          ok: false,
          status: 502,
          error: jsonError("Upstream returned an empty event stream", "bad_gateway"),
          upstreamUrl: sel.upstreamUrl,
        };
      }
      continue;
    }
    if (sel.ok) return sel;
    if (!firstErr) firstErr = sel;
    if (!shouldTryNextUpstreamUrl(sel.status)) return sel;
  }
  return firstErr || { ok: false, status: 502, error: jsonError("Upstream error", "bad_gateway") };
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    connection: "close",
  };
}

function encodeSseData(dataStr) {
  return `data: ${dataStr}\n\n`;
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sessionCacheUrl(sessionKey) {
  const hex = await sha256Hex(sessionKey);
  return `https://session.rsp2com/${hex}`;
}

async function getSessionPreviousResponseId(sessionKey) {
  try {
    if (!sessionKey || typeof caches === "undefined" || !caches.default) return null;
    const url = await sessionCacheUrl(sessionKey);
    const resp = await caches.default.match(url);
    if (!resp) return null;
    const data = await resp.json().catch(() => null);
    const rid = data?.previous_response_id;
    return typeof rid === "string" && rid ? rid : null;
  } catch {
    return null;
  }
}

async function setSessionPreviousResponseId(sessionKey, responseId) {
  try {
    if (!sessionKey || !responseId || typeof caches === "undefined" || !caches.default) return;
    const url = await sessionCacheUrl(sessionKey);
    const req = new Request(url, { method: "GET" });
    const resp = new Response(JSON.stringify({ previous_response_id: responseId, updated_at: Date.now() }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "max-age=86400",
      },
    });
    await caches.default.put(req, resp);
  } catch {
    // ignore
  }
}

// Cache for thought_signature (2025 Gemini API requirement)
// Maps call_id -> { thought_signature, thought, name }
async function thoughtSignatureCacheUrl(sessionKey) {
  const hex = await sha256Hex(`thought_sig_${sessionKey}`);
  return `https://thought-sig.rsp2com/${hex}`;
}

async function getThoughtSignatureCache(sessionKey) {
  try {
    if (!sessionKey || typeof caches === "undefined" || !caches.default) return {};
    const url = await thoughtSignatureCacheUrl(sessionKey);
    const resp = await caches.default.match(url);
    if (!resp) return {};
    const data = await resp.json().catch(() => null);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function setThoughtSignatureCache(sessionKey, callId, thoughtSignature, thought, name) {
  try {
    if (!sessionKey || !callId || typeof caches === "undefined" || !caches.default) return;
    // Get existing cache
    const existing = await getThoughtSignatureCache(sessionKey);
    // Add new entry
    existing[callId] = {
      thought_signature: thoughtSignature || "",
      thought: thought || "",
      name: name || "",
      updated_at: Date.now(),
    };
    // Limit cache size (keep last 100 entries)
    const entries = Object.entries(existing);
    if (entries.length > 100) {
      entries.sort((a, b) => (b[1].updated_at || 0) - (a[1].updated_at || 0));
      const kept = Object.fromEntries(entries.slice(0, 100));
      Object.keys(existing).forEach((k) => {
        if (!(k in kept)) delete existing[k];
      });
    }
    const url = await thoughtSignatureCacheUrl(sessionKey);
    const req = new Request(url, { method: "GET" });
    const resp = new Response(JSON.stringify(existing), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "max-age=86400",
      },
    });
    await caches.default.put(req, resp);
  } catch {
    // ignore
  }
}

function getSessionKey(request, reqJson, token) {
  const headerKey = request.headers.get("x-session-id");
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
  const user = reqJson?.user;
  if (typeof user === "string" && user.trim()) return user.trim();

  // Best-effort: derive a stable per-conversation key when the client can't send `x-session-id`/`user`.
  // This prevents different chat threads from sharing the same cached `previous_response_id`.
  const messages = Array.isArray(reqJson?.messages) ? reqJson.messages : [];
  let firstUserText = "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user") continue;
    const t = normalizeMessageContent(m.content);
    if (typeof t === "string" && t.trim()) {
      firstUserText = t.trim();
      break;
    }
  }
  if (firstUserText) {
    const model = typeof reqJson?.model === "string" ? reqJson.model.trim() : "";
    const fp = `${model}\n${firstUserText}`.slice(0, 512);
    return token ? `${token}|${fp}` : fp;
  }

  return token || "";
}

function hasAssistantMessage(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && typeof m === "object" && m.role === "assistant") return true;
  }
  return false;
}

function indexOfLastAssistantMessage(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && typeof m === "object" && m.role === "assistant") return i;
  }
  return -1;
}

function lastUserMessageParts(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user") continue;
    const parts = messageContentToResponsesParts(m.content);
    if (parts.length) return parts;
    const reasoning = m.reasoning_content;
    if (typeof reasoning === "string" && reasoning.trim()) return [{ type: "input_text", text: reasoning }];
  }
  return [];
}

function normalizeAuthValue(raw) {
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (!value) return "";

  // Strip accidental surrounding quotes (common when copy/pasting secrets).
  for (let i = 0; i < 2; i++) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
      continue;
    }
    break;
  }

  // Strip accidental "Bearer " prefix in stored secrets.
  if (value.toLowerCase().startsWith("bearer ")) value = value.slice(7).trim();

  return value;
}

function normalizeReasoningEffort(raw) {
  if (typeof raw !== "string") return "";
  const v0 = raw.trim();
  if (!v0) return "";
  const v = v0.toLowerCase();
  if (v === "off" || v === "no" || v === "false" || v === "0" || v === "disable" || v === "disabled") return "";
  return v;
}

function getReasoningEffort(reqJson, env) {
  const body = reqJson && typeof reqJson === "object" ? reqJson : null;
  const hasReq =
    Boolean(body && ("reasoning_effort" in body || "reasoningEffort" in body)) ||
    Boolean(body && body.reasoning && typeof body.reasoning === "object" && "effort" in body.reasoning);

  const fromReq =
    body?.reasoning_effort ?? body?.reasoningEffort ?? (body?.reasoning && typeof body.reasoning === "object" ? body.reasoning.effort : undefined);
  const reqEffort = normalizeReasoningEffort(String(fromReq ?? ""));
  if (reqEffort) return reqEffort;
  if (hasReq) return "";

  const envRaw = typeof env?.RESP_REASONING_EFFORT === "string" ? env.RESP_REASONING_EFFORT : "";
  const envEffort = normalizeReasoningEffort(envRaw);
  if (envEffort) return envEffort;
  if (envRaw && envRaw.trim()) return "";

  // Default: low (best-effort). If you want to send no reasoning params, set RESP_REASONING_EFFORT=off.
  return "low";
}

function appendInstructions(base, extra) {
  const b = typeof base === "string" ? base.trim() : "";
  const e = typeof extra === "string" ? extra.trim() : "";
  if (!e) return b;
  if (!b) return e;
  if (b.includes(e)) return b;
  return `${b}\n\n${e}`;
}

function copilotToolUseInstructionsText() {
  return [
    "Tool use:",
    "- When tools are provided, use them to perform actions (file edits, patches, searches).",
    "- Do not say you will write/edit files and stop; call the relevant tool with valid JSON arguments.",
    "- Do not claim you changed files unless you actually called a tool and received a result.",
  ].join("\n");
}

function shouldInjectCopilotToolUseInstructions(request, reqJson) {
  const ua = request.headers.get("user-agent") || "";
  if (typeof ua !== "string") return false;
  if (!ua.toLowerCase().includes("oai-compatible-copilot/")) return false;
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  return tools.length > 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const reqId = crypto.randomUUID();
    const debug = isDebugEnabled(env);
    const startedAt = Date.now();

    if (debug) {
      const authHeader = request.headers.get("authorization") || "";
      const hasBearer = typeof authHeader === "string" && authHeader.toLowerCase().includes("bearer ");
      const xApiKey = request.headers.get("x-api-key") || "";
      logDebug(debug, reqId, "inbound request", {
        method: request.method,
        host: url.host,
        path,
        search: url.search || "",
        userAgent: request.headers.get("user-agent") || "",
        cfRay: request.headers.get("cf-ray") || "",
        hasAuthorization: Boolean(authHeader),
        authScheme: hasBearer ? "bearer" : authHeader ? "custom" : "",
        authorizationLen: typeof authHeader === "string" ? authHeader.length : 0,
        hasXApiKey: Boolean(xApiKey),
        xApiKeyLen: typeof xApiKey === "string" ? xApiKey.length : 0,
        contentType: request.headers.get("content-type") || "",
        contentLength: request.headers.get("content-length") || "",
      });
    }

    const workerAuthKeys = getWorkerAuthKeys(env);
    if (!workerAuthKeys.length) {
      return jsonResponse(500, jsonError("Server misconfigured: missing WORKER_AUTH_KEY/WORKER_AUTH_KEYS", "server_error"));
    }

    const authHeader = request.headers.get("authorization");
    let token = bearerToken(authHeader);
    if (!token && typeof authHeader === "string") {
      // Allow `Authorization: <token>` (no scheme) if it's a single value.
      const maybe = authHeader.trim();
      if (maybe && !maybe.includes(" ")) token = maybe;
    }
    if (!token) token = request.headers.get("x-api-key");
    token = normalizeAuthValue(token);

    if (!token) {
      return new Response(JSON.stringify(jsonError("Missing API key", "unauthorized")), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "www-authenticate": "Bearer" },
      });
    }
    if (!workerAuthKeys.includes(token)) {
      return new Response(JSON.stringify(jsonError("Unauthorized", "unauthorized")), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "www-authenticate": "Bearer" },
      });
    }

    if (debug) {
      logDebug(debug, reqId, "auth ok", { tokenLen: token.length, authKeyCount: workerAuthKeys.length });
    }

    if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
      return jsonResponse(200, { ok: true, time: Math.floor(Date.now() / 1000) });
    }

    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      const modelsEnv = env.ADAPTER_MODELS || env.MODELS;
      const modelIds = modelsEnv
        ? modelsEnv.split(",").map((m) => m.trim()).filter(Boolean)
        : [env.DEFAULT_MODEL || "gpt-5.2"];
      if (debug) {
        logDebug(debug, reqId, "models list", { count: modelIds.length, defaultModel: env.DEFAULT_MODEL || "gpt-5.2" });
      }
      return jsonResponse(200, {
        object: "list",
        data: modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(404, jsonError("Not found", "not_found"));
    }

    if (!(path === "/v1/chat/completions" || path === "/chat/completions" || path === "/v1/completions" || path === "/completions")) {
      return jsonResponse(404, jsonError("Not found", "not_found"));
    }

    let reqJson;
    try {
      reqJson = await request.json();
    } catch {
      return jsonResponse(400, jsonError("Invalid JSON body"));
    }
    if (!reqJson || typeof reqJson !== "object") return jsonResponse(400, jsonError("Invalid JSON body"));

    const model = reqJson.model;
    if (typeof model !== "string" || !model.trim()) return jsonResponse(400, jsonError("Missing required field: model"));

    const stream = Boolean(reqJson.stream);
    const isTextCompletions = path === "/v1/completions" || path === "/completions";
    const isChatCompletions = path === "/v1/chat/completions" || path === "/chat/completions";

    if (debug) {
      logDebug(debug, reqId, "request parsed", {
        model,
        stream,
        endpoint: isTextCompletions ? "completions" : isChatCompletions ? "chat.completions" : "unknown",
        hasTools: Array.isArray(reqJson.tools) && reqJson.tools.length > 0,
        toolCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
        hasToolChoice: reqJson.tool_choice != null,
        hasMessages: Array.isArray(reqJson.messages),
        messagesCount: Array.isArray(reqJson.messages) ? reqJson.messages.length : 0,
        hasPrompt: "prompt" in reqJson,
        maxTokens: Number.isInteger(reqJson.max_tokens) ? reqJson.max_tokens : Number.isInteger(reqJson.max_completion_tokens) ? reqJson.max_completion_tokens : null,
      });
    }

    // Gemini adapter: OpenAI Chat Completions -> Gemini (generateContent / streamGenerateContent).
    if (isChatCompletions && isGeminiModelId(model)) {
      const geminiBase = normalizeAuthValue(env.GEMINI_BASE_URL);
      const geminiKey = normalizeAuthValue(env.GEMINI_API_KEY);
      if (!geminiBase) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_BASE_URL", "server_error"));
      if (!geminiKey) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_API_KEY", "server_error"));

      const geminiModelId = normalizeGeminiModelId(model, env);
      const geminiUrl = buildGeminiGenerateContentUrl(geminiBase, geminiModelId, stream);
      if (!geminiUrl) return jsonResponse(500, jsonError("Server misconfigured: invalid GEMINI_BASE_URL", "server_error"));

      // Get session key and thought_signature cache for 2025 API
      const sessionKey = getSessionKey(request, reqJson, token);
      const thoughtSigCache = sessionKey ? await getThoughtSignatureCache(sessionKey) : {};

      let geminiBody;
      try {
        const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";
        geminiBody = await openaiChatToGeminiRequest(reqJson, env, fetch, extraSystemText, thoughtSigCache);
      } catch (err) {
        const message = err instanceof Error ? err.message : "failed to build Gemini request";
        return jsonResponse(400, jsonError(`Invalid request: ${message}`));
      }

      const geminiHeaders = {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${geminiKey}`,
        "x-api-key": geminiKey,
        "x-goog-api-key": geminiKey,
      };

      if (debug) {
        const geminiBodyLog = safeJsonStringifyForLog(geminiBody);
        logDebug(debug, reqId, "gemini request", {
          url: geminiUrl,
          originalModel: model,
          normalizedModel: geminiModelId,
          stream,
          sessionKey: sessionKey ? maskSecret(sessionKey) : "",
          thoughtSigCacheEntries: sessionKey ? Object.keys(thoughtSigCache).length : 0,
          headers: redactHeadersForLog(geminiHeaders),
          bodyLen: geminiBodyLog.length,
          bodyPreview: previewString(geminiBodyLog, 2400),
        });
      }

      let gemResp;
      try {
        const t0 = Date.now();
        gemResp = await fetch(geminiUrl, { method: "POST", headers: geminiHeaders, body: JSON.stringify(geminiBody) });
        if (debug) {
          logDebug(debug, reqId, "gemini response headers", {
            status: gemResp.status,
            ok: gemResp.ok,
            contentType: gemResp.headers.get("content-type") || "",
            elapsedMs: Date.now() - t0,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "fetch failed";
        if (debug) logDebug(debug, reqId, "gemini fetch error", { error: message });
        return jsonResponse(502, jsonError(`Upstream fetch failed: ${message}`, "bad_gateway"));
      }

      if (!gemResp.ok) {
        let rawErr = "";
        try {
          rawErr = await gemResp.text();
        } catch {}
        if (debug) logDebug(debug, reqId, "gemini upstream error", { status: gemResp.status, errorPreview: previewString(rawErr, 1200) });
        let message = `Gemini upstream error (status ${gemResp.status})`;
        try {
          const obj = JSON.parse(rawErr);
          const m = obj?.error?.message ?? obj?.message;
          if (typeof m === "string" && m.trim()) message = m.trim();
        } catch {
          if (rawErr && rawErr.trim()) message = rawErr.trim().slice(0, 500);
        }
        const code = gemResp.status === 401 ? "unauthorized" : "bad_gateway";
        return jsonResponse(gemResp.status, jsonError(message, code));
      }

      if (!stream) {
        let gjson = null;
        try {
          gjson = await gemResp.json();
        } catch {
          return jsonResponse(502, jsonError("Gemini upstream returned invalid JSON", "bad_gateway"));
        }

        const { text, toolCalls, finish_reason, usage } = geminiExtractTextAndToolCalls(gjson);
        if (debug) {
          logDebug(debug, reqId, "gemini parsed", {
            finish_reason,
            textLen: typeof text === "string" ? text.length : 0,
            textPreview: typeof text === "string" ? previewString(text, 800) : "",
            toolCalls: toolCalls.map((c) => ({ name: c.function?.name || "", id: c.id || "", argsLen: c.function?.arguments?.length || 0, hasThoughtSig: !!c.thought_signature })),
            usage: usage || null,
          });
        }
        const created = Math.floor(Date.now() / 1000);
        const toolCallsOut = toolCalls.map((c) => {
          // Return standard OpenAI format without thought_signature (cached internally)
          return { id: c.id, type: "function", function: c.function };
        });
        
        // Cache thought_signature for future requests (2025 API requirement)
        if (sessionKey && toolCalls.length) {
          for (const tc of toolCalls) {
            if (tc.thought_signature && tc.id) {
              await setThoughtSignatureCache(sessionKey, tc.id, tc.thought_signature, tc.thought || "", tc.function?.name || "");
            }
          }
        }
        
        return jsonResponse(200, {
          id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: toolCallsOut.length ? null : text || "", ...(toolCallsOut.length ? { tool_calls: toolCallsOut } : {}) },
              finish_reason,
            },
          ],
          ...(usage ? { usage } : {}),
        });
      }

      // stream=true: translate Gemini SSE -> OpenAI SSE
      let chatId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
      let created = Math.floor(Date.now() / 1000);
      let outModel = model;
      let sentRole = false;
      let sentFinal = false;
      let sawDataLine = false;
      let raw = "";
      let textSoFar = "";
      let lastFinishReason = "";
      let bytesIn = 0;
      let sseDataLines = 0;

      const toolCallKeyToMeta = new Map(); // key -> { id, index, name, args }
      let nextToolIndex = 0;

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        const ensureAssistantRoleSent = async () => {
          if (sentRole) return;
          const roleChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          await writer.write(encoder.encode(encodeSseData(JSON.stringify(roleChunk))));
          sentRole = true;
        };

        const emitTextDelta = async (deltaText) => {
          if (typeof deltaText !== "string" || !deltaText) return;
          await ensureAssistantRoleSent();
          const chunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
          };
          await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
        };

        const emitToolCallDelta = async (meta, argsDelta) => {
          if (!meta || typeof meta !== "object") return;
          await ensureAssistantRoleSent();
          const fn = {};
          if (typeof meta.name === "string" && meta.name.trim()) fn.name = meta.name.trim();
          if (typeof argsDelta === "string" && argsDelta) fn.arguments = argsDelta;
          const tcItem = {
            index: meta.index,
            id: meta.id,
            type: "function",
            function: fn,
          };
          // Note: thought_signature is cached internally but NOT returned to client
          // to maintain OpenAI API compatibility
          const chunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [tcItem],
                },
                finish_reason: null,
              },
            ],
          };
          await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
        };

        const upsertToolCall = async (nameRaw, argsRaw, thoughtSignature, thought) => {
          const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
          if (!name) return;
          const argsStr = geminiArgsToJsonString(argsRaw);
          const key = `${name}\n${argsStr}`;

          if (!toolCallKeyToMeta.has(key)) {
            const meta = {
              id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
              index: nextToolIndex++,
              name,
              args: "",
            };
            // Store thought_signature and thought for Gemini thinking models (2025 API)
            if (typeof thoughtSignature === "string" && thoughtSignature.trim()) {
              meta.thought_signature = thoughtSignature.trim();
            }
            if (typeof thought === "string") {
              meta.thought = thought;
            }
            toolCallKeyToMeta.set(key, meta);
          }
          const meta = toolCallKeyToMeta.get(key);
          const full = argsStr && argsStr.trim() ? argsStr : "{}";
          const delta = meta.args && full.startsWith(meta.args) ? full.slice(meta.args.length) : full;
          if (!delta) return;
          meta.args = full;
          await emitToolCallDelta(meta, delta);
        };

        try {
          const reader = gemResp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let finished = false;
          // Track pending thought for 2025 API (thought comes in separate part before functionCall)
          let pendingThought = "";
          let pendingThoughtSignature = "";
          
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            bytesIn += chunkText.length;
            raw += chunkText;
            buf += chunkText;
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              sseDataLines++;
              sawDataLine = true;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === "[DONE]") {
                finished = true;
                break;
              }
              let payload;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }

              const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
              const cand = candidates.length ? candidates[0] : null;
              const fr = cand?.finishReason ?? cand?.finish_reason;
              if (typeof fr === "string" && fr.trim()) lastFinishReason = fr.trim();

              const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
              
              const textJoined = parts
                .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("");

              for (const p of parts) {
                if (!p || typeof p !== "object") continue;
                
                const fc = p.functionCall;
                if (fc && typeof fc === "object") {
                  // Extract thought_signature from the same part (2025 API: thoughtSignature is sibling to functionCall)
                  const thoughtSig =
                    p.thoughtSignature || p.thought_signature ||
                    fc.thoughtSignature || fc.thought_signature ||
                    pendingThoughtSignature ||
                    "";
                  const thought =
                    p.thought ||
                    fc.thought ||
                    pendingThought ||
                    "";
                  
                  await upsertToolCall(fc.name, fc.args, thoughtSig, thought);
                  // Reset pending after consuming
                  pendingThought = "";
                  pendingThoughtSignature = "";
                  continue;
                }
                
                // Handle standalone thought parts (if they come separately)
                if (typeof p.thought === "string" || typeof p.thought_signature === "string" || typeof p.thoughtSignature === "string") {
                  if (typeof p.thought === "string") pendingThought = p.thought;
                  if (typeof p.thought_signature === "string") pendingThoughtSignature = p.thought_signature;
                  if (typeof p.thoughtSignature === "string") pendingThoughtSignature = p.thoughtSignature;
                  continue;
                }
              }

              if (textJoined) {
                let delta = "";
                if (textJoined.startsWith(textSoFar)) {
                  delta = textJoined.slice(textSoFar.length);
                  textSoFar = textJoined;
                } else if (textSoFar.startsWith(textJoined)) {
                  delta = "";
                } else {
                  delta = textJoined;
                  textSoFar += textJoined;
                }
                if (delta) await emitTextDelta(delta);
              }
            }
          }
          try {
            await reader.cancel();
          } catch {}
        } catch (err) {
          if (debug) {
            const message = err instanceof Error ? err.message : String(err ?? "stream failed");
            logDebug(debug, reqId, "gemini stream translate error", { error: message });
          }
        } finally {
          if (!sawDataLine && raw.trim()) {
            if (debug) logDebug(debug, reqId, "gemini stream non-sse sample", { rawPreview: previewString(raw, 1200) });
            try {
              const obj = JSON.parse(raw);
              const extracted = geminiExtractTextAndToolCalls(obj);
              if (Array.isArray(extracted.toolCalls)) {
                for (const tc of extracted.toolCalls) await upsertToolCall(tc.function?.name, safeJsonParse(tc.function?.arguments || "{}").value);
              }
              if (extracted.text) await emitTextDelta(extracted.text);
              if (typeof extracted.finish_reason === "string" && extracted.finish_reason) lastFinishReason = extracted.finish_reason;
            } catch {
              // ignore
            }
          }
          if (debug) {
            logDebug(debug, reqId, "gemini stream summary", {
              bytesIn,
              sseDataLines,
              toolCalls: Array.from(toolCallKeyToMeta.values()).map((m) => ({ name: m.name || "", id: m.id || "", argsLen: m.args?.length || 0, hasThoughtSig: !!m.thought_signature })),
              finish_reason: geminiFinishReasonToOpenai(lastFinishReason, toolCallKeyToMeta.size > 0),
              textLen: textSoFar.length,
            });
          }

          if (!sentFinal) {
            try {
              const finishReason = geminiFinishReasonToOpenai(lastFinishReason, toolCallKeyToMeta.size > 0);
              const finalChunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: outModel,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
            } catch {
              // ignore
            }
            sentFinal = true;
          }
          
          // Cache thought_signature for future requests (2025 API requirement)
          if (sessionKey && toolCallKeyToMeta.size > 0) {
            for (const [, meta] of toolCallKeyToMeta) {
              if (meta.thought_signature && meta.id) {
                await setThoughtSignatureCache(sessionKey, meta.id, meta.thought_signature, meta.thought || "", meta.name || "");
              }
            }
          }
          
          try {
            await writer.write(encoder.encode(encodeSseData("[DONE]")));
          } catch {}
          try {
            await writer.close();
          } catch {}
        }
      })();

      return new Response(readable, { status: 200, headers: sseHeaders() });
    }

    // Claude adapter: OpenAI Chat Completions -> Claude Messages API
    if (isChatCompletions && isClaudeModelId(model)) {
      const claudeBase = normalizeAuthValue(env.CLAUDE_BASE_URL);
      const claudeKey = normalizeAuthValue(env.CLAUDE_API_KEY);
      if (!claudeBase) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_BASE_URL", "server_error"));
      if (!claudeKey) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_API_KEY", "server_error"));

      const claudeUrls = buildClaudeMessagesUrls(claudeBase, env.CLAUDE_MESSAGES_PATH);
      if (debug) logDebug(debug, reqId, "claude upstream urls", { urls: claudeUrls });
      if (!claudeUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid CLAUDE_BASE_URL", "server_error"));

      const claudeModel = normalizeClaudeModelId(model, env);
      const { messages: claudeMessages, system: claudeSystem } = openaiChatToClaudeMessages(reqJson.messages || []);
      const claudeTools = openaiToolsToClaude(reqJson.tools);

      if (debug) {
        logDebug(debug, reqId, "claude request build", {
          originalModel: model,
          normalizedModel: claudeModel,
          stream,
          messagesCount: claudeMessages.length,
          hasSystem: !!claudeSystem,
          systemLen: typeof claudeSystem === "string" ? claudeSystem.length : 0,
          toolsCount: claudeTools.length,
          reqToolsCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
        });
      }

      let maxTokens = 8192;
      const maxTokensCap = typeof env.CLAUDE_MAX_TOKENS === "string" ? parseInt(env.CLAUDE_MAX_TOKENS, 10) : 8192;
      if (Number.isInteger(reqJson.max_tokens)) maxTokens = reqJson.max_tokens;
      if (Number.isInteger(reqJson.max_completion_tokens)) maxTokens = reqJson.max_completion_tokens;
      if (maxTokensCap > 0 && maxTokens > maxTokensCap) maxTokens = maxTokensCap;

      const claudeBody = {
        model: claudeModel,
        messages: claudeMessages,
        max_tokens: maxTokens,
        stream: stream,
      };
      if (claudeSystem) claudeBody.system = claudeSystem;
      if (claudeTools.length) claudeBody.tools = claudeTools;
      applyTemperatureTopPFromRequest(reqJson, claudeBody);

      const claudeHeaders = {
        "content-type": "application/json",
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
      };
      if (claudeTools.length) claudeHeaders["anthropic-beta"] = "tools-2024-04-04";
      if (debug) {
        const claudeBodyLog = safeJsonStringifyForLog(claudeBody);
        logDebug(debug, reqId, "claude request", {
          urlsCount: claudeUrls.length,
          headers: redactHeadersForLog(claudeHeaders),
          bodyLen: claudeBodyLog.length,
          bodyPreview: previewString(claudeBodyLog, 2400),
        });
      }

      let claudeResp = null;
      let claudeUrl = "";
      let lastClaudeError = "";
      for (const url of claudeUrls) {
        if (debug) logDebug(debug, reqId, "claude upstream try", { url });
        try {
          const t0 = Date.now();
          const resp = await fetch(url, { method: "POST", headers: claudeHeaders, body: JSON.stringify(claudeBody) });
          if (debug) {
            logDebug(debug, reqId, "claude upstream response", {
              url,
              status: resp.status,
              ok: resp.ok,
              contentType: resp.headers.get("content-type") || "",
              elapsedMs: Date.now() - t0,
            });
          }
          if (resp.ok) {
            claudeResp = resp;
            claudeUrl = url;
            break;
          }
          const errText = await resp.text().catch(() => "");
          lastClaudeError = errText;
          if (debug) logDebug(debug, reqId, "claude upstream error", { url, status: resp.status, errorPreview: previewString(errText, 1200) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
          lastClaudeError = message;
          if (debug) logDebug(debug, reqId, "claude fetch error", { url, error: message });
        }
      }

      if (!claudeResp) {
        return jsonResponse(502, jsonError("All Claude upstream URLs failed: " + lastClaudeError.slice(0, 200), "bad_gateway"));
      }

      const chatId = `chatcmpl_claude_${Date.now().toString(36)}`;
      const created = Math.floor(Date.now() / 1000);

      if (!stream) {
        let cjson;
        try {
          cjson = await claudeResp.json();
        } catch {
          return jsonResponse(502, jsonError("Invalid JSON from Claude upstream", "bad_gateway"));
        }

        const { text, toolCalls } = claudeExtractTextAndToolCalls(cjson.content);
        const finishReason = claudeStopReasonToOpenai(cjson.stop_reason);
        const usage = claudeUsageToOpenaiUsage(cjson.usage);
        if (debug) {
          logDebug(debug, reqId, "claude parsed", {
            url: claudeUrl,
            finish_reason: finishReason,
            stop_reason: cjson.stop_reason || "",
            textLen: typeof text === "string" ? text.length : 0,
            textPreview: typeof text === "string" ? previewString(text, 800) : "",
            toolCalls: toolCalls.map((c) => ({ name: c.function?.name || "", id: c.id || "", argsLen: c.function?.arguments?.length || 0 })),
            usage: usage || null,
          });
        }

        const message = { role: "assistant", content: text || null };
        if (toolCalls.length) message.tool_calls = toolCalls;

        return jsonResponse(200, {
          id: chatId,
          object: "chat.completion",
          created,
          model: claudeModel,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage,
        });
      }

      // Streaming response
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        const streamStartedAt = Date.now();
        let textContent = "";
        const toolCalls = [];
        let finishReason = "stop";
        try {
          const reader = claudeResp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const toolCallArgs = {}; // Map tool_use index to accumulated arguments
          let currentToolIndex = -1;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;

              let event;
              try { event = JSON.parse(data); } catch { continue; }

              if (event.type === "content_block_start") {
                if (event.content_block?.type === "tool_use") {
                  currentToolIndex = toolCalls.length;
                  toolCalls.push({
                    index: currentToolIndex,
                    id: event.content_block.id,
                    type: "function",
                    function: { name: event.content_block.name, arguments: "" },
                  });
                  toolCallArgs[currentToolIndex] = "";
                  // Send tool call start chunk
                  const chunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: claudeModel,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: currentToolIndex,
                          id: event.content_block.id,
                          type: "function",
                          function: { name: event.content_block.name, arguments: "" },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                }
              } else if (event.type === "content_block_delta") {
                if (event.delta?.type === "text_delta" && event.delta.text) {
                  textContent += event.delta.text;
                  const chunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: claudeModel,
                    choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                  // Accumulate tool call arguments
                  if (currentToolIndex >= 0) {
                    toolCallArgs[currentToolIndex] = (toolCallArgs[currentToolIndex] || "") + event.delta.partial_json;
                    // Send argument delta chunk
                    const chunk = {
                      id: chatId,
                      object: "chat.completion.chunk",
                      created,
                      model: claudeModel,
                      choices: [{
                        index: 0,
                        delta: {
                          tool_calls: [{
                            index: currentToolIndex,
                            function: { arguments: event.delta.partial_json },
                          }],
                        },
                        finish_reason: null,
                      }],
                    };
                    await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                  }
                }
              } else if (event.type === "content_block_stop") {
                // Block finished, update tool call arguments if it was a tool_use
                if (currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
                  toolCalls[currentToolIndex].function.arguments = toolCallArgs[currentToolIndex] || "{}";
                }
              } else if (event.type === "message_delta" && event.delta?.stop_reason) {
                finishReason = claudeStopReasonToOpenai(event.delta.stop_reason);
              }
            }
          }

          // Final chunk with finish_reason
          const finalChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: claudeModel,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          };
          await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
          await writer.write(encoder.encode(encodeSseData("[DONE]")));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "stream error");
          if (debug) logDebug(debug, reqId, "claude stream error", { error: message });
        } finally {
          if (debug) {
            logDebug(debug, reqId, "claude stream summary", {
              url: claudeUrl,
              elapsedMs: Date.now() - streamStartedAt,
              textLen: textContent.length,
              toolCallsCount: toolCalls.length,
              finish_reason: finishReason,
            });
          }
          try { await writer.close(); } catch {}
        }
      })();

      return new Response(readable, { status: 200, headers: sseHeaders() });
    }

    const upstreamBase = normalizeAuthValue(env.OPENAI_BASE_URL);
    if (!upstreamBase) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_BASE_URL", "server_error"));
    const upstreamKey = normalizeAuthValue(env.OPENAI_API_KEY);
    if (!upstreamKey) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_API_KEY", "server_error"));

    const upstreamUrls = buildUpstreamUrls(upstreamBase, env.RESP_RESPONSES_PATH);
    if (debug) logDebug(debug, reqId, "openai upstream urls", { urls: upstreamUrls });
    // Some gateways (including Codex SDK style proxies) require upstream `stream: true`.
    // We can still serve non-stream clients by buffering the SSE output into a single JSON response.
    const upstreamStream = true;

    const headers = {
      "content-type": "application/json",
      accept: upstreamStream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${upstreamKey}`,
      "x-api-key": upstreamKey,
      "x-goog-api-key": upstreamKey,
      "openai-beta": "responses=v1",
    };
    if (debug) logDebug(debug, reqId, "openai upstream headers", { headers: redactHeadersForLog(headers) });

    const reasoningEffort = getReasoningEffort(reqJson, env);
    if (isTextCompletions) {
      const prompt = reqJson.prompt;
      const promptText = Array.isArray(prompt) ? (typeof prompt[0] === "string" ? prompt[0] : "") : typeof prompt === "string" ? prompt : String(prompt ?? "");
      const responsesReq = {
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: promptText }] }],
      };
      if (reasoningEffort) responsesReq.reasoning = { effort: reasoningEffort };
      if (Number.isInteger(reqJson.max_tokens)) responsesReq.max_output_tokens = reqJson.max_tokens;
      if (Number.isInteger(reqJson.max_completion_tokens)) responsesReq.max_output_tokens = reqJson.max_completion_tokens;
      applyTemperatureTopPFromRequest(reqJson, responsesReq);
      if ("stop" in reqJson) responsesReq.stop = reqJson.stop;

      const variants = responsesReqVariants(responsesReq, upstreamStream);
      if (debug) {
        const reqLog = safeJsonStringifyForLog(responsesReq);
        logDebug(debug, reqId, "openai completions request", {
          variants: variants.length,
          requestLen: reqLog.length,
          requestPreview: previewString(reqLog, 2400),
        });
      }
      const sel = await selectUpstreamResponseAny(upstreamUrls, headers, variants, debug, reqId);
      if (!sel.ok && debug) {
        logDebug(debug, reqId, "openai upstream failed", { path, upstreamUrl: sel.upstreamUrl, status: sel.status, error: sel.error });
      }
      if (!sel.ok) return jsonResponse(sel.status, sel.error);
      if (debug) {
        logDebug(debug, reqId, "openai upstream selected", {
          path,
          upstreamUrl: sel.upstreamUrl,
          status: sel.resp.status,
          contentType: sel.resp.headers.get("content-type") || "",
        });
      }

      if (!stream) {
        let fullText = "";
        let sawDelta = false;
        let sawAnyText = false;
        let sawDataLine = false;
        let raw = "";
        const reader = sel.resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finished = false;
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          raw += chunkText;
          buf += chunkText;
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            sawDataLine = true;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finished = true;
              break;
            }
            let payload;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            const evt = payload?.type;
            if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string") {
              sawDelta = true;
              sawAnyText = true;
              fullText += payload.delta;
              continue;
            }
            if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string") {
              sawAnyText = true;
              fullText += payload.text;
              continue;
            }
            if (!sawDelta && !sawAnyText && evt === "response.completed" && payload?.response && typeof payload.response === "object") {
              const t = extractOutputTextFromResponsesResponse(payload.response);
              if (t) {
                sawAnyText = true;
                fullText += t;
              }
              finished = true;
              break;
            }
            if (evt === "response.completed" || evt === "response.failed") {
              finished = true;
              break;
            }
          }
        }
        try {
          await reader.cancel();
        } catch {}
        if (!sawDataLine && raw.trim()) {
          try {
            const obj = JSON.parse(raw);
            if (typeof obj === "string") {
              const ex = extractFromResponsesSseText(obj);
              if (ex.text) fullText = ex.text;
            } else {
              const responseObj = obj?.response && typeof obj.response === "object" ? obj.response : obj;
              fullText = extractOutputTextFromResponsesResponse(responseObj) || fullText;
            }
          } catch {
            // ignore
          }
        }
        if (debug && !sawDataLine) {
          logDebug(debug, reqId, "openai upstream non-sse sample", { rawPreview: previewString(raw, 1200) });
        }
        if (debug) {
          logDebug(debug, reqId, "openai completions parsed", {
            textLen: fullText.length,
            textPreview: previewString(fullText, 800),
            sawDataLine,
            sawDelta,
            sawAnyText,
            rawLen: raw.length,
          });
        }
        const created = Math.floor(Date.now() / 1000);
        return jsonResponse(200, {
          id: `cmpl_${crypto.randomUUID().replace(/-/g, "")}`,
          object: "text_completion",
          created,
          model,
          choices: [{ text: fullText, index: 0, logprobs: null, finish_reason: "stop" }],
        });
      }

      // stream=true for /v1/completions
      const completionId = `cmpl_${crypto.randomUUID().replace(/-/g, "")}`;
      const created = Math.floor(Date.now() / 1000);
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        const streamStartedAt = Date.now();
        let sentFinal = false;
        let sawDelta = false;
        let sentAnyText = false;
        let sawDataLine = false;
        let raw = "";
        try {
          const reader = sel.resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let finished = false;
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            raw += chunkText;
            buf += chunkText;
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              sawDataLine = true;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                finished = true;
                break;
              }
              let payload;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }
              const evt = payload?.type;
              if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string" && payload.delta) {
                sawDelta = true;
                sentAnyText = true;
                const chunk = {
                  id: completionId,
                  object: "text_completion",
                  created,
                  model,
                  choices: [{ text: payload.delta, index: 0, logprobs: null, finish_reason: null }],
                };
                await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                continue;
              }
              if (
                !sawDelta &&
                (evt === "response.output_text.done" || evt === "response.refusal.done") &&
                typeof payload.text === "string" &&
                payload.text
              ) {
                sentAnyText = true;
                const chunk = {
                  id: completionId,
                  object: "text_completion",
                  created,
                  model,
                  choices: [{ text: payload.text, index: 0, logprobs: null, finish_reason: null }],
                };
                await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                continue;
              }
              if (!sawDelta && !sentAnyText && evt === "response.completed" && payload?.response && typeof payload.response === "object") {
                const t = extractOutputTextFromResponsesResponse(payload.response);
                if (t) {
                  sentAnyText = true;
                  const chunk = {
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [{ text: t, index: 0, logprobs: null, finish_reason: null }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                }
                finished = true;
                break;
              }
              if (evt === "response.completed" || evt === "response.failed") {
                finished = true;
                break;
              }
            }
          }
          try {
            await reader.cancel();
          } catch {}
        } catch (err) {
          if (debug) {
            const message = err instanceof Error ? err.message : String(err ?? "stream error");
            logDebug(debug, reqId, "openai completions stream error", { error: message });
          }
        } finally {
          if (!sawDataLine && !sentAnyText && raw.trim()) {
            if (debug) logDebug(debug, reqId, "openai upstream non-sse sample", { rawPreview: previewString(raw, 1200) });
            try {
              const obj = JSON.parse(raw);
              if (typeof obj === "string") {
                const ex = extractFromResponsesSseText(obj);
                const t = ex.text;
                if (t) {
                  sentAnyText = true;
                  const chunk = {
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [{ text: t, index: 0, logprobs: null, finish_reason: null }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                }
              } else {
                const responseObj = obj?.response && typeof obj.response === "object" ? obj.response : obj;
                const t = extractOutputTextFromResponsesResponse(responseObj);
                if (t) {
                  sentAnyText = true;
                  const chunk = {
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [{ text: t, index: 0, logprobs: null, finish_reason: null }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                }
              }
            } catch {
              // ignore
            }
          }
          if (!sentFinal) {
            const finalChunk = {
              id: completionId,
              object: "text_completion",
              created,
              model,
              choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
            };
            try {
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
              await writer.write(encoder.encode(encodeSseData("[DONE]")));
            } catch {}
          }
          try {
            await writer.close();
          } catch {}
          if (debug) {
            logDebug(debug, reqId, "openai completions stream summary", {
              completionId,
              elapsedMs: Date.now() - streamStartedAt,
              sentAnyText,
              sawDelta,
              sawDataLine,
              rawLen: raw.length,
            });
          }
        }
      })();

      return new Response(readable, { status: 200, headers: sseHeaders() });
    }

    // /v1/chat/completions
    const messages = reqJson.messages;
    if (!Array.isArray(messages)) return jsonResponse(400, jsonError("Missing required field: messages"));

    const sessionKey = getSessionKey(request, reqJson, token);
    if (debug) logDebug(debug, reqId, "openai session", { sessionKey: sessionKey ? maskSecret(sessionKey) : "", multiTurnPossible: hasAssistantMessage(messages) });

    const { instructions, input } = chatMessagesToResponsesInput(messages);
    if (!input.length) return jsonResponse(400, jsonError("messages must include at least one non-system message"));

    const effectiveInstructions = appendInstructions(
      instructions,
      shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : ""
    );

    const fullReq = {
      model,
      input,
    };
    if (reasoningEffort) fullReq.reasoning = { effort: reasoningEffort };
    if (effectiveInstructions) fullReq.instructions = effectiveInstructions;
    applyTemperatureTopPFromRequest(reqJson, fullReq);
    if ("stop" in reqJson) fullReq.stop = reqJson.stop;

    const respTools = openaiToolsToResponsesTools(reqJson.tools);
    if (respTools.length) fullReq.tools = respTools;
    const respToolChoice = openaiToolChoiceToResponsesToolChoice(reqJson.tool_choice);
    if (respToolChoice !== undefined) fullReq.tool_choice = respToolChoice;

    const maxTokens = Number.isInteger(reqJson.max_tokens)
      ? reqJson.max_tokens
      : Number.isInteger(reqJson.max_completion_tokens)
        ? reqJson.max_completion_tokens
        : null;
    if (Number.isInteger(maxTokens)) fullReq.max_output_tokens = maxTokens;

    const lastAssistantIdx = indexOfLastAssistantMessage(messages);
    const multiTurn = lastAssistantIdx >= 0;
    const prevId = multiTurn ? await getSessionPreviousResponseId(sessionKey) : null;
    const deltaMessages = prevId && lastAssistantIdx >= 0 ? messages.slice(lastAssistantIdx + 1) : [];
    const deltaConv = deltaMessages.length ? chatMessagesToResponsesInput(deltaMessages) : { input: [] };

    const prevReq =
      prevId && Array.isArray(deltaConv.input) && deltaConv.input.length
        ? {
            model,
            input: deltaConv.input,
            previous_response_id: prevId,
          }
        : null;
    if (prevReq) {
      if (reasoningEffort) prevReq.reasoning = { effort: reasoningEffort };
      if (effectiveInstructions) prevReq.instructions = effectiveInstructions;
      applyTemperatureTopPFromRequest(reqJson, prevReq);
      if ("stop" in reqJson) prevReq.stop = reqJson.stop;

      const respTools = openaiToolsToResponsesTools(reqJson.tools);
      if (respTools.length) prevReq.tools = respTools;
      const respToolChoice = openaiToolChoiceToResponsesToolChoice(reqJson.tool_choice);
      if (respToolChoice !== undefined) prevReq.tool_choice = respToolChoice;
      if (Number.isInteger(maxTokens)) prevReq.max_output_tokens = maxTokens;
    }

    const primaryReq = prevReq || fullReq;
    const primaryVariants = responsesReqVariants(primaryReq, upstreamStream);
    if (debug) {
      const reqLog = safeJsonStringifyForLog(primaryReq);
      logDebug(debug, reqId, "openai chat request", {
        usingPreviousResponseId: Boolean(prevReq?.previous_response_id),
        previous_response_id: prevReq?.previous_response_id ? maskSecret(prevReq.previous_response_id) : "",
        deltaMessagesCount: deltaMessages.length,
        totalMessagesCount: messages.length,
        inputItems: Array.isArray(primaryReq?.input) ? primaryReq.input.length : 0,
        hasInstructions: Boolean(primaryReq?.instructions),
        instructionsLen: typeof primaryReq?.instructions === "string" ? primaryReq.instructions.length : 0,
        toolsCount: Array.isArray(primaryReq?.tools) ? primaryReq.tools.length : 0,
        toolChoice: primaryReq?.tool_choice ?? null,
        max_output_tokens: primaryReq?.max_output_tokens ?? null,
        variants: primaryVariants.length,
        requestLen: reqLog.length,
        requestPreview: previewString(reqLog, 2400),
      });
    }
    let sel = await selectUpstreamResponseAny(upstreamUrls, headers, primaryVariants, debug, reqId);

    // If the upstream doesn't accept `previous_response_id`, fall back to full history.
    if (!sel.ok && prevReq) {
      const fallbackVariants = responsesReqVariants(fullReq, upstreamStream);
      const sel2 = await selectUpstreamResponseAny(upstreamUrls, headers, fallbackVariants, debug, reqId);
      if (sel2.ok) sel = sel2;
    }
    if (!sel.ok && debug) {
      logDebug(debug, reqId, "openai upstream failed", { path, upstreamUrl: sel.upstreamUrl, status: sel.status, error: sel.error });
    }
    if (!sel.ok) return jsonResponse(sel.status, sel.error);
    if (debug) {
      logDebug(debug, reqId, "openai upstream selected", {
        path,
        upstreamUrl: sel.upstreamUrl,
        status: sel.resp.status,
        contentType: sel.resp.headers.get("content-type") || "",
      });
    }

    if (!stream) {
      let fullText = "";
      let responseId = null;
      let sawDelta = false;
      let sawAnyText = false;
      let sawToolCall = false;
      let sawDataLine = false;
      let raw = "";
      const toolCallsById = new Map(); // call_id -> { name, args }
      const upsertToolCall = (callIdRaw, nameRaw, argsRaw, mode) => {
        const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
        if (!callId) return;
        sawToolCall = true;
        const buf = toolCallsById.get(callId) || { name: "", args: "" };
        if (typeof nameRaw === "string" && nameRaw.trim()) buf.name = nameRaw.trim();
        if (typeof argsRaw === "string" && argsRaw) {
          if (mode === "delta") {
            buf.args += argsRaw;
          } else {
            const full = argsRaw;
            if (!buf.args) buf.args = full;
            else if (full.startsWith(buf.args)) buf.args = full;
            else buf.args = full;
          }
        }
        toolCallsById.set(callId, buf);
      };
      const reader = sel.resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        raw += chunkText;
        buf += chunkText;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          sawDataLine = true;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          const evt = payload?.type;
          if (evt === "response.created" && payload?.response && typeof payload.response === "object") {
            const rid = payload.response.id;
            if (typeof rid === "string" && rid) responseId = rid;
            continue;
          }
          if (evt === "response.function_call_arguments.delta") {
            upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.delta, "delta");
            continue;
          }
          if (evt === "response.function_call_arguments.done" || evt === "response.function_call.done") {
            upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.arguments, "full");
            continue;
          }
          if ((evt === "response.output_item.added" || evt === "response.output_item.done") && payload?.item && typeof payload.item === "object") {
            const item = payload.item;
            if (item?.type === "function_call") {
              upsertToolCall(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments, "full");
            }
            continue;
          }
          if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string") {
            sawDelta = true;
            sawAnyText = true;
            fullText += payload.delta;
            continue;
          }
          if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string") {
            sawAnyText = true;
            fullText += payload.text;
            continue;
          }
          if (evt === "response.completed" && payload?.response && typeof payload.response === "object") {
            const rid = payload.response.id;
            if (!responseId && typeof rid === "string" && rid) responseId = rid;
            if (!sawDelta && !sawAnyText) {
              const t = extractOutputTextFromResponsesResponse(payload.response);
              if (t) {
                sawAnyText = true;
                fullText += t;
              }
            }
            const calls = extractToolCallsFromResponsesResponse(payload.response);
            for (const c of calls) upsertToolCall(c.call_id, c.name, c.arguments, "full");
            finished = true;
            break;
          }
          if (evt === "response.failed") {
            finished = true;
            break;
          }
        }
      }
      try {
        await reader.cancel();
      } catch {}
      if (!sawDataLine && raw.trim()) {
        try {
          const obj = JSON.parse(raw);
          if (typeof obj === "string") {
            const ex = extractFromResponsesSseText(obj);
            if (!responseId && ex.responseId) responseId = ex.responseId;
            if (!sawAnyText && ex.text) fullText = ex.text;
            if (Array.isArray(ex.toolCalls)) {
              for (const c of ex.toolCalls) upsertToolCall(c.call_id, c.name, c.arguments, "delta");
            }
          } else {
            const responseObj = obj?.response && typeof obj.response === "object" ? obj.response : obj;
            const rid = responseObj?.id;
            if (!responseId && typeof rid === "string" && rid) responseId = rid;
            if (!sawAnyText) fullText = extractOutputTextFromResponsesResponse(responseObj) || fullText;
            const calls = extractToolCallsFromResponsesResponse(responseObj);
            for (const c of calls) upsertToolCall(c.call_id, c.name, c.arguments, "full");
          }
        } catch {
          // ignore
        }
      }
      if (debug && !sawDataLine) {
        logDebug(debug, reqId, "openai upstream non-sse sample", { rawPreview: previewString(raw, 1200) });
      }
      const created = Math.floor(Date.now() / 1000);
      if (responseId) {
        await setSessionPreviousResponseId(sessionKey, responseId);
        if (debug) logDebug(debug, reqId, "openai session cache set", { previous_response_id: maskSecret(responseId) });
      }
      const outId = responseId ? `chatcmpl_${responseId}` : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
      const toolCalls = Array.from(toolCallsById.entries()).map(([id, v]) => ({
        id,
        type: "function",
        function: { name: v.name || "unknown_tool", arguments: v.args && v.args.trim() ? v.args : "{}" },
      }));
      const finishReason = toolCalls.length ? "tool_calls" : "stop";
      const contentValue = fullText && fullText.length ? fullText : toolCalls.length ? null : "";
      if (debug) {
        logDebug(debug, reqId, "openai chat parsed", {
          responseId: responseId ? maskSecret(responseId) : "",
          outId,
          finish_reason: finishReason,
          textLen: fullText.length,
          textPreview: previewString(fullText, 800),
          toolCalls: toolCalls.map((c) => ({
            id: c.id,
            name: c.function?.name || "",
            argsLen: c.function?.arguments?.length || 0,
          })),
          sawDataLine,
          sawDelta,
          sawAnyText,
          rawLen: raw.length,
        });
      }
      return jsonResponse(200, {
        id: outId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: contentValue, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: finishReason,
          },
        ],
      });
    }

    // stream=true
    let chatId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    let created = Math.floor(Date.now() / 1000);
    let outModel = model;
    let responseId = null;
    let sawDelta = false;
    let sentAnyText = false;
    let sawToolCall = false;
    let sawDataLine = false;
    let raw = "";
    let sentRole = false;
    let sentFinal = false;
    const toolCallIdToIndex = new Map(); // call_id -> index
    let nextToolCallIndex = 0;
    const toolCallsById = new Map(); // call_id -> { name, args }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const streamStartedAt = Date.now();
      const getToolCallIndex = (callId) => {
        const id = typeof callId === "string" ? callId.trim() : "";
        if (!id) return 0;
        if (!toolCallIdToIndex.has(id)) toolCallIdToIndex.set(id, nextToolCallIndex++);
        return toolCallIdToIndex.get(id) || 0;
      };

      const ensureAssistantRoleSent = async () => {
        if (sentRole) return;
        const roleChunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: outModel,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        };
        await writer.write(encoder.encode(encodeSseData(JSON.stringify(roleChunk))));
        sentRole = true;
      };

      const emitToolCallDelta = async (callId, name, argsDelta) => {
        const id = typeof callId === "string" ? callId.trim() : "";
        if (!id) return;
        const fn = {};
        if (typeof name === "string" && name.trim()) fn.name = name.trim();
        if (typeof argsDelta === "string" && argsDelta) fn.arguments = argsDelta;
        if (!("name" in fn) && !("arguments" in fn)) return;

        sawToolCall = true;
        await ensureAssistantRoleSent();
        const idx = getToolCallIndex(id);
        const chunk = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: outModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id,
                    type: "function",
                    function: fn,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
      };

      const upsertToolCall = async (callIdRaw, nameRaw, argsRaw, mode) => {
        const callId = typeof callIdRaw === "string" ? callIdRaw.trim() : "";
        if (!callId) return;

        const buf0 = toolCallsById.get(callId) || { name: "", args: "" };
        const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : buf0.name;
        let delta = "";

        if (typeof argsRaw === "string" && argsRaw) {
          if (mode === "delta") {
            delta = argsRaw;
            buf0.args += argsRaw;
          } else {
            const full = argsRaw;
            delta = buf0.args && full.startsWith(buf0.args) ? full.slice(buf0.args.length) : full;
            buf0.args = full;
          }
        }

        buf0.name = name;
        toolCallsById.set(callId, buf0);
        await emitToolCallDelta(callId, name, delta);
      };

      try {
        const reader = sel.resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finished = false;
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          raw += chunkText;
          buf += chunkText;
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            sawDataLine = true;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finished = true;
              break;
            }
            let payload;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            const evt = payload?.type;

            if (evt === "response.created" && payload?.response && typeof payload.response === "object") {
              const rid = payload.response.id;
              if (typeof rid === "string" && rid) {
                responseId = rid;
                chatId = `chatcmpl_${rid}`;
              }
              const m = payload.response.model;
              if (typeof m === "string" && m) outModel = m;
              const c = payload.response.created_at;
              if (Number.isInteger(c)) created = c;
              continue;
            }

            if (evt === "response.function_call_arguments.delta") {
              await upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.delta, "delta");
              continue;
            }

            if (evt === "response.function_call_arguments.done" || evt === "response.function_call.done") {
              await upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.arguments, "full");
              continue;
            }

            if ((evt === "response.output_item.added" || evt === "response.output_item.done") && payload?.item && typeof payload.item === "object") {
              const item = payload.item;
              if (item?.type === "function_call") {
                await upsertToolCall(
                  item.call_id ?? item.callId ?? item.id,
                  item.name ?? item.function?.name,
                  item.arguments ?? item.function?.arguments,
                  "full"
                );
              }
              continue;
            }

            if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string" && payload.delta) {
              sawDelta = true;
              sentAnyText = true;
              await ensureAssistantRoleSent();
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: outModel,
                choices: [{ index: 0, delta: { content: payload.delta }, finish_reason: null }],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
              continue;
            }

            if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string" && payload.text) {
              sentAnyText = true;
              await ensureAssistantRoleSent();
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: outModel,
                choices: [{ index: 0, delta: { content: payload.text }, finish_reason: null }],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
              continue;
            }

            if (evt === "response.completed" || evt === "response.failed") {
              if (evt === "response.completed" && payload?.response && typeof payload.response === "object") {
                const rid = payload.response.id;
                if (!responseId && typeof rid === "string" && rid) responseId = rid;

                const calls = extractToolCallsFromResponsesResponse(payload.response);
                for (const c of calls) await upsertToolCall(c.call_id, c.name, c.arguments, "full");

                if (!sawDelta && !sentAnyText) {
                  const t = extractOutputTextFromResponsesResponse(payload.response);
                  if (t) {
                    sentAnyText = true;
                    await ensureAssistantRoleSent();
                    const chunk = {
                      id: chatId,
                      object: "chat.completion.chunk",
                      created,
                      model: outModel,
                      choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
                    };
                    await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                  }
                }
              }
              if (!sentFinal) {
                const finishReason = toolCallsById.size ? "tool_calls" : "stop";
                const finalChunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model: outModel,
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                };
                await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
                sentFinal = true;
              }
              finished = true;
              break;
            }
          }
        }
        try {
          await reader.cancel();
        } catch {}
      } catch (err) {
        if (debug) {
          const message = err instanceof Error ? err.message : String(err ?? "stream error");
          logDebug(debug, reqId, "openai stream translate error", { error: message });
        }
      } finally {
        if (!sawDataLine && raw.trim()) {
          if (debug) logDebug(debug, reqId, "openai upstream non-sse sample", { rawPreview: previewString(raw, 1200) });
          try {
            const obj = JSON.parse(raw);
            if (typeof obj === "string") {
              const ex = extractFromResponsesSseText(obj);
              if (!responseId && ex.responseId) {
                responseId = ex.responseId;
                chatId = `chatcmpl_${ex.responseId}`;
              }
              if (typeof ex.model === "string" && ex.model) outModel = ex.model;
              if (Number.isInteger(ex.createdAt)) created = ex.createdAt;
              if (Array.isArray(ex.toolCalls)) {
                for (const c of ex.toolCalls) await upsertToolCall(c.call_id, c.name, c.arguments, "delta");
              }
              if (!sentAnyText && ex.text) {
                sentAnyText = true;
                await ensureAssistantRoleSent();
                const chunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created,
                  model: outModel,
                  choices: [{ index: 0, delta: { content: ex.text }, finish_reason: null }],
                };
                await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
              }
            } else {
              const responseObj = obj?.response && typeof obj.response === "object" ? obj.response : obj;
              const rid = responseObj?.id;
              if (!responseId && typeof rid === "string" && rid) {
                responseId = rid;
                chatId = `chatcmpl_${rid}`;
              }
              const m = responseObj?.model;
              if (typeof m === "string" && m) outModel = m;
              const c = responseObj?.created_at;
              if (Number.isInteger(c)) created = c;

              const calls = extractToolCallsFromResponsesResponse(responseObj);
              for (const tc of calls) await upsertToolCall(tc.call_id, tc.name, tc.arguments, "full");

              if (!sentAnyText) {
                const t = extractOutputTextFromResponsesResponse(responseObj);
                if (t) {
                  sentAnyText = true;
                  await ensureAssistantRoleSent();
                  const chunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created,
                    model: outModel,
                    choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
                  };
                  await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
                }
              }
            }
          } catch {
            // ignore
          }
        }
        if (!sentFinal) {
          try {
            const finishReason = toolCallsById.size ? "tool_calls" : "stop";
            const finalChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: outModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            };
            await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
          } catch {}
        }
        try {
          await writer.write(encoder.encode(encodeSseData("[DONE]")));
        } catch {}
        try {
          await writer.close();
        } catch {}
        if (responseId) await setSessionPreviousResponseId(sessionKey, responseId);
        if (debug) {
          const finishReason = toolCallsById.size ? "tool_calls" : "stop";
          logDebug(debug, reqId, "openai stream summary", {
            elapsedMs: Date.now() - streamStartedAt,
            responseId: responseId ? maskSecret(responseId) : "",
            outModel,
            sentAnyText,
            sawToolCall,
            sawDataLine,
            rawLen: raw.length,
            finish_reason: finishReason,
            toolCallsCount: toolCallsById.size,
            toolCalls: Array.from(toolCallsById.entries()).map(([id, v]) => ({
              id,
              name: v?.name || "",
              argsLen: typeof v?.args === "string" ? v.args.length : 0,
            })),
          });
        }
      }
    })();

    if (debug) logDebug(debug, reqId, "request done", { elapsedMs: Date.now() - startedAt });
    return new Response(readable, { status: 200, headers: sseHeaders() });
  },
};
