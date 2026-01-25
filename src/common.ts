export type Env = Record<string, string | undefined>;

export function jsonResponse(status: number, obj: unknown, extraHeaders: Record<string, unknown> | undefined = undefined): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-rsp4copilot": "1",
  };
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v == null) continue;
      headers[k] = String(v);
    }
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

export function jsonError(message, code = "bad_request") {
  const c = typeof code === "string" ? code.trim().toLowerCase() : "";
  let type = "invalid_request_error";
  if (c === "server_error") type = "server_error";
  else if (c === "bad_gateway") type = "server_error";
  else if (c === "unauthorized") type = "authentication_error";
  else if (c === "not_found") type = "not_found_error";
  else if (c === "invalid_request_error") type = "invalid_request_error";
  return { error: { message, type, code } };
}

export function joinUrls(urls: unknown): string {
  const list = Array.isArray(urls) ? urls.map((u) => String(u ?? "").trim()).filter(Boolean) : [];
  return list.join(",");
}

export function parseBoolEnv(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!v) return false;
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

export const DEFAULT_RSP4COPILOT_MAX_TURNS = 40;
export const DEFAULT_RSP4COPILOT_MAX_MESSAGES = 200;
export const DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS = 300000;

function parseIntEnv(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function getRsp4CopilotLimits(env) {
  const defaultMaxInputChars = parseIntEnv(env?.DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS, DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS);
  return {
    maxTurns: parseIntEnv(env?.RSP4COPILOT_MAX_TURNS, DEFAULT_RSP4COPILOT_MAX_TURNS),
    maxMessages: parseIntEnv(env?.RSP4COPILOT_MAX_MESSAGES, DEFAULT_RSP4COPILOT_MAX_MESSAGES),
    maxInputChars: parseIntEnv(env?.RSP4COPILOT_MAX_INPUT_CHARS, defaultMaxInputChars),
  };
}

function estimateJsonChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value ?? "").length;
  }
}

export function measureOpenAIChatMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let turns = 0;
  let inputChars = 0;
  for (const m of list) {
    if (m && typeof m === "object") {
      const r = typeof m.role === "string" ? m.role.trim().toLowerCase() : "";
      if (r === "user") turns++;
    }
    inputChars += estimateJsonChars(m);
  }
  return { turns, messages: list.length, inputChars };
}

export function trimOpenAIChatMessages(messages: any, limits: any): any {
  const list = Array.isArray(messages) ? messages : [];

  const maxTurns = Number.isFinite(limits?.maxTurns) ? limits.maxTurns : DEFAULT_RSP4COPILOT_MAX_TURNS;
  const maxMessages = Number.isFinite(limits?.maxMessages) ? limits.maxMessages : DEFAULT_RSP4COPILOT_MAX_MESSAGES;
  const maxInputChars = Number.isFinite(limits?.maxInputChars) ? limits.maxInputChars : DEFAULT_RSP4COPILOT_MAX_INPUT_CHARS;

  const before = measureOpenAIChatMessages(list);

  const turnsCap = maxTurns > 0 ? maxTurns : Infinity;
  const messagesCap = maxMessages > 0 ? maxMessages : Infinity;
  const charsCap = maxInputChars > 0 ? maxInputChars : Infinity;

  if (turnsCap === Infinity && messagesCap === Infinity && charsCap === Infinity) {
    return { ok: true, messages: list, trimmed: false, before, after: before };
  }

  const roleOf = (m) => (m && typeof m === "object" && typeof m.role === "string" ? m.role.trim().toLowerCase() : "");
  const isSystemRole = (r) => r === "system" || r === "developer";

  // Keep the leading system/developer prefix, then trim the conversation tail.
  let systemPrefixEnd = 0;
  while (systemPrefixEnd < list.length && isSystemRole(roleOf(list[systemPrefixEnd]))) systemPrefixEnd++;

  const userIdxs: number[] = [];
  for (let i = systemPrefixEnd; i < list.length; i++) {
    if (roleOf(list[i]) === "user") userIdxs.push(i);
  }
  const lastUserIdx = userIdxs.length ? userIdxs[userIdxs.length - 1] : -1;

  let sysStart = 0;
  let restStart = systemPrefixEnd;
  let restEnd = list.length;

  if (turnsCap !== Infinity && userIdxs.length > turnsCap) {
    restStart = userIdxs[userIdxs.length - turnsCap];
  }

  const lens = list.map(estimateJsonChars);
  const prefixSum = new Array(list.length + 1);
  prefixSum[0] = 0;
  for (let i = 0; i < list.length; i++) prefixSum[i + 1] = prefixSum[i] + lens[i];

  const selectedCount = () => (systemPrefixEnd - sysStart) + (restEnd - restStart);
  const selectedChars = () => (prefixSum[systemPrefixEnd] - prefixSum[sysStart]) + (prefixSum[restEnd] - prefixSum[restStart]);

  let droppedTurns = 0;
  let droppedSystem = 0;
  let droppedTail = 0;

  const advanceRestStart = () => {
    if (restStart >= restEnd) return false;

    // Drop any prelude before the first user message.
    if (userIdxs.length && restStart < userIdxs[0]) {
      restStart = userIdxs[0];
      return true;
    }

    // Find the next user message after the current start.
    let next = -1;
    for (const u of userIdxs) {
      if (u > restStart) {
        next = u;
        break;
      }
    }

    // Refuse to drop the last user turn (must keep the latest user input).
    if (lastUserIdx >= 0 && (next < 0 || next > lastUserIdx)) return false;

    if (next >= 0) {
      restStart = next;
      return true;
    }

    // No user messages: drop everything.
    restStart = restEnd;
    return true;
  };

  const dropTail = () => {
    if (restEnd <= restStart) return false;

    // Keep at least the latest user message (if present) and keep at least 1 message overall.
    const minEnd = Math.max(restStart + 1, lastUserIdx >= 0 ? lastUserIdx + 1 : restStart + 1);
    if (restEnd <= minEnd) return false;

    restEnd--;
    droppedTail++;
    return true;
  };

  const enforceMessagesCap = () => {
    while (messagesCap !== Infinity && selectedCount() > messagesCap) {
      if (advanceRestStart()) {
        droppedTurns++;
        continue;
      }
      if (sysStart < systemPrefixEnd) {
        sysStart++;
        droppedSystem++;
        continue;
      }
      // Last resort: drop tail messages, but never drop the latest user input.
      if (dropTail()) {
        continue;
      }
      break;
    }
    return { ok: true };
  };

  const enforceCharsCap = () => {
    while (charsCap !== Infinity && selectedChars() > charsCap) {
      if (advanceRestStart()) {
        droppedTurns++;
        continue;
      }
      if (sysStart < systemPrefixEnd) {
        sysStart++;
        droppedSystem++;
        continue;
      }
      // Last resort: drop tail messages, but never drop the latest user input.
      if (dropTail()) {
        continue;
      }
      break;
    }
    return { ok: true };
  };

  const r1 = enforceMessagesCap();
  if (!r1.ok) return r1;
  const r2 = enforceCharsCap();
  if (!r2.ok) return r2;

  let out = [...list.slice(sysStart, systemPrefixEnd), ...list.slice(restStart, restEnd)];

  const safeMessagesChars = (msgs) => measureOpenAIChatMessages(msgs).inputChars;
  const truncateStringFieldToFit = (msgs, parentObj, key, maxLen) => {
    if (!parentObj || typeof parentObj !== "object") return 0;
    const raw = parentObj[key];
    if (typeof raw !== "string") return 0;

    // Keep the tail of the string (often contains the actual user question).
    let lo = 0;
    let hi = raw.length;
    const original = raw;

    parentObj[key] = "";
    if (safeMessagesChars(msgs) > maxLen) {
      parentObj[key] = original;
      return 0;
    }

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      parentObj[key] = original.slice(-mid);
      if (safeMessagesChars(msgs) <= maxLen) lo = mid;
      else hi = mid - 1;
    }

    parentObj[key] = original.slice(-lo);
    return original.length - lo;
  };

  let truncatedInputChars = 0;
  if (charsCap !== Infinity && safeMessagesChars(out) > charsCap) {
    // Clone messages before mutating any nested text fields.
    out = out.map((m) => {
      if (!m || typeof m !== "object") return m;
      const cloned = { ...m };
      if (Array.isArray(m.content)) cloned.content = m.content.map((p) => (p && typeof p === "object" ? { ...p } : p));
      return cloned;
    });

    const tryTruncateLargestText = () => {
      let best: { obj: any; key: string; len: number } | null = null;
      for (const m of out) {
        if (!m || typeof m !== "object") continue;
        const content = m.content;
        if (typeof content === "string") {
          if (!best || content.length > best.len) best = { obj: m, key: "content", len: content.length };
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== "object") continue;
            if (typeof part.text === "string") {
              const t = part.text;
              if (!best || t.length > best.len) best = { obj: part, key: "text", len: t.length };
            }
          }
        }
      }
      if (!best || best.len <= 0) return false;
      const cut = truncateStringFieldToFit(out, best.obj, best.key, charsCap);
      if (cut <= 0) return false;
      truncatedInputChars += cut;
      return true;
    };

    let guard = 0;
    while (safeMessagesChars(out) > charsCap && guard++ < 12) {
      if (!tryTruncateLargestText()) break;
    }
  }

  const after = measureOpenAIChatMessages(out);
  const trimmed = sysStart > 0 || restStart > systemPrefixEnd || restEnd < list.length || truncatedInputChars > 0;
  return { ok: true, messages: out, trimmed, before, after, droppedTurns, droppedSystem, droppedTail, truncatedInputChars };
}

export function isDebugEnabled(env) {
  return parseBoolEnv(typeof env?.RSP4COPILOT_DEBUG === "string" ? env.RSP4COPILOT_DEBUG : "");
}

export function maskSecret(value) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!v) return "";
  const s = v.trim();
  if (!s) return "";
  if (s.length <= 8) return `${"*".repeat(s.length)} (len=${s.length})`;
  return `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
}

export function previewString(value, maxLen = 1200) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!v) return "";
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen)}…(truncated,len=${v.length})`;
}

export function redactHeadersForLog(headers) {
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

export function safeJsonStringifyForLog(value, maxStringLen = 800) {
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

export function logDebug(enabled, reqId, label, data) {
  if (!enabled) return;
  const prefix = reqId ? `[rsp4copilot][${reqId}]` : "[rsp4copilot]";
  if (data === undefined) {
    console.log(`${prefix} ${label}`);
  } else {
    console.log(`${prefix} ${label}`, data);
  }
}

export function normalizeAuthValue(raw) {
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (!value) return "";

  // Strip accidental surrounding quotes (common when copy/pasting secrets).
  for (let i = 0; i < 2; i++) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
      continue;
    }
    break;
  }

  // Strip accidental "Bearer " prefix in stored secrets.
  if (value.toLowerCase().startsWith("bearer ")) value = value.slice(7).trim();

  return value;
}

export function getWorkerAuthKeys(env) {
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

export function bearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const value = headerValue.trim();
  if (value.toLowerCase().startsWith("bearer ")) return value.slice(7).trim();
  return null;
}

export function normalizeBaseUrl(raw) {
  const base = (raw || "").trim();
  if (!base) return base;
  const lower = base.toLowerCase();
  if (lower === "http" || lower === "http:" || lower === "https" || lower === "https:") return "";
  if (base.startsWith("http://") || base.startsWith("https://")) return base;
  return `https://${base}`;
}

export function joinPathPrefix(prefixPath, suffixPath) {
  const p = (prefixPath || "").replace(/\/+$/, "");
  const s0 = (suffixPath || "").trim();
  const s = s0.startsWith("/") ? s0 : `/${s0}`;
  if (!p || p === "/") return s;
  return `${p}${s}`;
}

export function applyTemperatureTopPFromRequest(reqJson, target) {
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

export function normalizeMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
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
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return String(content);
}

export function normalizeToolCallsFromChatMessage(msg) {
  const out: any[] = [];
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
    const item: any = { call_id: callId, name: toolName, arguments: argStr };
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
    const thoughtSignature = tc.thought_signature ?? tc.thoughtSignature ?? fn?.thought_signature ?? fn?.thoughtSignature ?? "";
    const thought = tc.thought ?? tc.reasoning ?? fn?.thought ?? fn?.reasoning ?? "";
    pushToolCall(id, name, args, thoughtSignature, thought);
  }

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

export function appendInstructions(base, extra) {
  const b = typeof base === "string" ? base.trim() : "";
  const e = typeof extra === "string" ? extra.trim() : "";
  if (!e) return b;
  if (!b) return e;
  if (b.includes(e)) return b;
  return `${b}\n\n${e}`;
}

export function sseHeaders(extraHeaders: Record<string, unknown> | undefined = undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-rsp4copilot": "1",
  };
  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v == null) continue;
      headers[k] = String(v);
    }
  }
  return headers;
}

export function encodeSseData(dataStr) {
  return `data: ${dataStr}\n\n`;
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getSessionKey(request, reqJson, token) {
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
