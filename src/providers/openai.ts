import {
  appendInstructions,
  applyTemperatureTopPFromRequest,
  encodeSseData,
  getSessionKey,
  getRsp4CopilotLimits,
  joinPathPrefix,
  jsonError,
  jsonResponse,
  logDebug,
  maskSecret,
  measureOpenAIChatMessages,
  normalizeAuthValue,
  normalizeBaseUrl,
  normalizeMessageContent,
  normalizeToolCallsFromChatMessage,
  previewString,
  redactHeadersForLog,
  safeJsonStringifyForLog,
  sha256Hex,
  sseHeaders,
  trimOpenAIChatMessages,
} from "../common";

function normalizeDuplicateV1Segments(path: unknown): string {
  let p = typeof path === "string" ? path : path == null ? "" : String(path);
  if (!p) return p;

  // Normalize accidental double slashes first.
  p = p.replace(/\/{2,}/g, "/");

  // Collapse consecutive `/v1` segments (e.g. `/openai/v1/v1/responses` -> `/openai/v1/responses`).
  for (let i = 0; i < 6; i++) {
    const next = p.replace(/\/v1\/+v1(\/|$)/g, "/v1$1");
    if (next === p) break;
    p = next;
  }

  return p;
}

function buildUpstreamUrls(raw, responsesPathRaw) {
  const value = (raw || "").trim();
  if (!value) return [];

  const configuredResponsesPath = (responsesPathRaw || "").trim();
  const hasConfiguredResponsesPath = Boolean(configuredResponsesPath);

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
    // Prefer `/v1/responses` unless the base already includes `/v1`.
    // Avoid generating `/v1/v1/responses` when a base already ends with `/v1` (or `/openai/v1`).
    if (p.endsWith("/openai/v1") || p.endsWith("/v1")) return "/responses";
    return "/v1/responses";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const rawPath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const base0 = normalizeDuplicateV1Segments(rawPath);

      const basePathsSet = new Set<string>();
      const pushBase = (bp) => {
        const v = normalizeDuplicateV1Segments((bp || "").replace(/\/+$/, "") || "/");
        if (!v) return;
        basePathsSet.add(v);
      };

      // Accept both "base URL" and "full endpoint" inputs, and generate safe fallbacks.
      pushBase(base0);
      if (base0.endsWith("/responses")) pushBase(base0.replace(/\/responses$/, "") || "/");
      for (const bp of Array.from(basePathsSet)) {
        if (bp.endsWith("/v1")) pushBase(bp.replace(/\/v1$/, "") || "/");
      }

      for (const basePath of Array.from(basePathsSet)) {
        const isFullEndpoint = basePath.endsWith("/v1/responses") || basePath.endsWith("/responses");

        if (isFullEndpoint) {
          const u = new URL(normalized);
          u.pathname = basePath;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
          continue;
        }

        // Treat as base/prefix: append responses path.
        // If a configured responses path is provided, treat it as authoritative (avoid overriding it with inferred fallbacks).
        const preferred = hasConfiguredResponsesPath
          ? configuredResponsesPath.startsWith("/")
            ? configuredResponsesPath
            : `/${configuredResponsesPath}`
          : inferResponsesPath(basePath);

        const candidatesRaw = hasConfiguredResponsesPath
          ? [joinPathPrefix(basePath, preferred)]
          : [joinPathPrefix(basePath, preferred), joinPathPrefix(basePath, "/v1/responses"), joinPathPrefix(basePath, "/responses")];

        const candidates = candidatesRaw
          .map((p) => normalizeDuplicateV1Segments(p))
          .filter((path) => !String(path || "").includes("/v1/v1/responses"))
          .sort((a, b) => {
            if (hasConfiguredResponsesPath) return 0;
            const score = (p) => (String(p || "").includes("/v1/responses") ? 0 : 1);
            return score(a) - score(b);
          });

        for (const path of candidates) {
          const u = new URL(normalized);
          u.pathname = path;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
        }
      }
    } catch {
      // Ignore invalid URLs; caller will handle empty list.
    }
  }

  return out;
}

function buildChatCompletionsUrls(raw, chatPathRaw) {
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (!value) return [];

  const configuredChatPath = typeof chatPathRaw === "string" ? chatPathRaw.trim() : "";

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  const pushUrl = (urlStr) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferChatPath = (basePath) => {
    const p = (basePath || "").replace(/\/+$/, "");
    if (p.endsWith("/openai") || p.endsWith("/openai/v1")) return "/chat/completions";
    if (p.endsWith("/v1")) return "/chat/completions";
    return "/v1/chat/completions";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const rawPath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const base0 = normalizeDuplicateV1Segments(rawPath);

      const basePathsSet = new Set<string>();
      const pushBase = (bp) => {
        const v = normalizeDuplicateV1Segments((bp || "").replace(/\/+$/, "") || "/");
        if (!v) return;
        basePathsSet.add(v);
      };

      pushBase(base0);
      if (base0.endsWith("/chat/completions")) pushBase(base0.replace(/\/chat\/completions$/, "") || "/");
      for (const bp of Array.from(basePathsSet)) {
        if (bp.endsWith("/v1")) pushBase(bp.replace(/\/v1$/, "") || "/");
      }

      for (const basePath of Array.from(basePathsSet)) {
        const isFullEndpoint = basePath.endsWith("/v1/chat/completions") || basePath.endsWith("/chat/completions");

        if (isFullEndpoint) {
          const u = new URL(normalized);
          u.pathname = basePath;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
          continue;
        }

        const preferred = configuredChatPath
          ? configuredChatPath.startsWith("/")
            ? configuredChatPath
            : `/${configuredChatPath}`
          : inferChatPath(basePath);
        const candidates = configuredChatPath
          ? [joinPathPrefix(basePath, preferred)]
          : [joinPathPrefix(basePath, preferred), joinPathPrefix(basePath, "/v1/chat/completions"), joinPathPrefix(basePath, "/chat/completions")];

        for (const path of candidates) {
          const u = new URL(normalized);
          u.pathname = normalizeDuplicateV1Segments(path);
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
        }
      }
    } catch {
      // Ignore invalid URLs; caller will handle empty list.
    }
  }

  return out;
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

    const description = typeof t.description === "string" ? t.description : fn && typeof fn.description === "string" ? fn.description : "";
    const parameters =
      t.parameters && typeof t.parameters === "object"
        ? t.parameters
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

  const instructions = instructionsParts
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return { instructions: instructions || null, input: inputItems };
}

function shouldRetryUpstream(status, bodyText = "") {
  // Only retry variants for likely "payload/shape mismatch" errors.
  // Avoid spamming many retries for path/auth errors that some relays report as 400/422.
  if (status !== 400 && status !== 422) return false;

  const text = typeof bodyText === "string" ? bodyText : bodyText == null ? "" : String(bodyText);
  if (!text.trim()) return true;

  const t = text.toLowerCase();
  const has = (s) => t.includes(s);

  // Path/routing style errors (seen in some gateways).
  if (has("no static resource")) return false;
  if (has("unknown route")) return false;
  if (has("route ") && has(" not found")) return false;
  if (has("method not allowed")) return false;
  if (has("not found")) return false;

  // Auth/permission errors (variants won't help).
  if (has("invalid api key")) return false;
  if (has("api key format")) return false;
  if (has("missing api key")) return false;
  if (has("unauthorized")) return false;
  if (has("forbidden")) return false;

  // Model not found errors (variants won't help).
  if (has("model_not_found")) return false;
  if (has("does not exist")) return false;
  if (has("unknown model")) return false;

  return true;
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

  // Prompt caching / safety identifier compatibility:
  // Some relays reject unknown fields, so add progressively stripped variants as fallbacks.
  const cacheCompat = [];
  for (const v of variants) {
    cacheCompat.push(v);
    if (!v || typeof v !== "object") continue;

    const hasRetention = typeof v.prompt_cache_retention === "string" && v.prompt_cache_retention.trim();
    const hasSafety = typeof v.safety_identifier === "string" && v.safety_identifier.trim();
    if (!hasRetention && !hasSafety) continue;

    if (hasRetention) {
      const vNoRetention = { ...v };
      delete vNoRetention.prompt_cache_retention;
      cacheCompat.push(vNoRetention);
    }

    if (hasSafety) {
      const vNoSafety = { ...v };
      delete vNoSafety.safety_identifier;
      cacheCompat.push(vNoSafety);
    }

    const vNoCache = { ...v };
    delete vNoCache.prompt_cache_retention;
    delete vNoCache.safety_identifier;
    cacheCompat.push(vNoCache);
  }
  variants.length = 0;
  variants.push(...cacheCompat);

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

function safeJsonLen(value) {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s.length : String(s ?? "").length;
  } catch {
    return String(value ?? "").length;
  }
}

function trimOpenAIResponsesRequestToMaxChars(req, maxChars) {
  const limit = Number.isInteger(maxChars) ? maxChars : Number.isFinite(maxChars) ? Math.trunc(maxChars) : 0;
  const beforeLen = safeJsonLen(req);
  if (!(limit > 0) || beforeLen <= limit) {
    return {
      ok: true,
      trimmed: false,
      beforeLen,
      afterLen: beforeLen,
      droppedTurns: 0,
      droppedSystem: 0,
      droppedTail: 0,
      truncatedInputChars: 0,
      truncatedInstructionChars: 0,
      droppedTools: false,
      droppedUnpairedToolCalls: 0,
    };
  }

  if (!req || typeof req !== "object") {
    return { ok: false, error: `Input exceeds RSP4COPILOT_MAX_INPUT_CHARS=${limit}; reduce prompt size or raise the limit`, beforeLen };
  }

  let trimmed = false;
  let droppedTurns = 0;
  let droppedSystem = 0;
  let droppedTail = 0;
  let truncatedInputChars = 0;
  let truncatedInstructionChars = 0;
  let droppedTools = false;
  let droppedUnpairedToolCalls = 0;

  const roleOf = (item) => (item && typeof item === "object" && typeof item.role === "string" ? item.role.trim().toLowerCase() : "");
  const isSystemRole = (role) => role === "system" || role === "developer";
  const inputItemTypeOf = (item) => (item && typeof item === "object" && typeof item.type === "string" ? item.type.trim() : "");
  const callIdOf = (item) => {
    if (!item || typeof item !== "object") return "";
    const v = item.call_id ?? item.callId ?? item.id;
    return typeof v === "string" ? v.trim() : "";
  };

  const sanitizeResponsesToolPairs = () => {
    if (!Array.isArray(req.input) || req.input.length === 0) return 0;

    const outputCallIds = new Set();
    let sawFunctionCall = false;
    for (const item of req.input) {
      const t = inputItemTypeOf(item);
      if (t === "function_call") sawFunctionCall = true;
      if (t === "function_call_output") {
        const id = callIdOf(item);
        if (id) outputCallIds.add(id);
      }
    }
    if (!sawFunctionCall) return 0;

    let removed = 0;
    const nextInput = [];
    for (const item of req.input) {
      const t = inputItemTypeOf(item);
      if (t === "function_call") {
        const id = callIdOf(item);
        if (id && outputCallIds.has(id)) nextInput.push(item);
        else removed++;
        continue;
      }
      nextInput.push(item);
    }
    if (removed > 0) req.input = nextInput;
    return removed;
  };

  const truncateStringFieldToFit = (parentObj, key, maxLen) => {
    if (!parentObj || typeof parentObj !== "object") return 0;
    const raw = parentObj[key];
    if (typeof raw !== "string") return 0;

    // Keep the tail of the string (often contains the actual user question).
    let lo = 0;
    let hi = raw.length;
    const original = raw;

    // Fast path: try empty string first (if even this doesn't fit, caller must try other fields).
    parentObj[key] = "";
    if (safeJsonLen(req) > maxLen) {
      parentObj[key] = original;
      return 0;
    }

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      parentObj[key] = original.slice(-mid);
      if (safeJsonLen(req) <= maxLen) lo = mid;
      else hi = mid - 1;
    }

    parentObj[key] = original.slice(-lo);
    return original.length - lo;
  };

  const tryTrimInputWindow = () => {
    if (!Array.isArray(req.input) || req.input.length <= 1) return false;

    const input = req.input;

    const baseLen = safeJsonLen({ ...req, input: [] });
    if (baseLen > limit) return false;

    const lens = input.map((it) => safeJsonLen(it));
    const prefixSum = new Array(lens.length + 1);
    prefixSum[0] = 0;
    for (let i = 0; i < lens.length; i++) prefixSum[i + 1] = prefixSum[i] + lens[i];

    let systemPrefixEnd = 0;
    while (systemPrefixEnd < input.length && isSystemRole(roleOf(input[systemPrefixEnd]))) systemPrefixEnd++;

    const userIdxs = [];
    for (let i = systemPrefixEnd; i < input.length; i++) {
      if (roleOf(input[i]) === "user") userIdxs.push(i);
    }
    const lastUserIdx = userIdxs.length ? userIdxs[userIdxs.length - 1] : -1;

    let sysStart = 0;
    let restStart = systemPrefixEnd;
    let restEnd = input.length;

    const selectedCount = () => (systemPrefixEnd - sysStart) + (restEnd - restStart);
    const selectedLensSum = () => (prefixSum[systemPrefixEnd] - prefixSum[sysStart]) + (prefixSum[restEnd] - prefixSum[restStart]);
    const selectedLen = () => {
      const count = selectedCount();
      const commas = count > 1 ? count - 1 : 0;
      return baseLen + selectedLensSum() + commas;
    };

    const advanceRestStart = () => {
      if (restStart >= restEnd) return false;

      // Drop any prelude before the first user item.
      if (userIdxs.length && restStart < userIdxs[0]) {
        restStart = userIdxs[0];
        return true;
      }

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

    const dropTailOnce = () => {
      if (restEnd <= restStart) return false;
      const mustKeep = lastUserIdx >= 0 ? lastUserIdx + 1 : restStart + 1;
      const minEnd = Math.max(restStart + 1, mustKeep);
      if (restEnd <= minEnd) return false;
      restEnd--;
      return true;
    };

    let changed = false;
    while (selectedLen() > limit) {
      if (advanceRestStart()) {
        droppedTurns++;
        changed = true;
        continue;
      }
      if (sysStart < systemPrefixEnd) {
        sysStart++;
        droppedSystem++;
        changed = true;
        continue;
      }
      if (dropTailOnce()) {
        droppedTail++;
        changed = true;
        continue;
      }
      break;
    }

    if (!changed) return false;
    req.input = [...input.slice(sysStart, systemPrefixEnd), ...input.slice(restStart, restEnd)];
    droppedUnpairedToolCalls += sanitizeResponsesToolPairs();
    return true;
  };

  const tryTruncateLargestInputText = () => {
    if (!Array.isArray(req.input)) return false;

    // Clone input tree before mutating any nested text fields (variants may share item object references).
    req.input = req.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const cloned = { ...item };
      if (Array.isArray(item.content)) {
        cloned.content = item.content.map((part) => (part && typeof part === "object" ? { ...part } : part));
      }
      if (item.function && typeof item.function === "object") {
        cloned.function = { ...item.function };
      }
      return cloned;
    });

    let best = null;
    for (const item of req.input) {
      if (!item || typeof item !== "object") continue;
      const r = roleOf(item);
      const t = inputItemTypeOf(item);
      if (r && r !== "user" && r !== "system" && r !== "developer") {
        // Non-message items can still contain huge strings (e.g., tool outputs).
        if (t !== "function_call" && t !== "function_call_output") continue;
      }

      const content = item.content;
      if (typeof content === "string") {
        if (!best || content.length > best.len) best = { obj: item, key: "content", len: content.length };
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          if (typeof part.text === "string") {
            const t = part.text;
            if (!best || t.length > best.len) best = { obj: part, key: "text", len: t.length };
          }
        }
      }

      if (t === "function_call") {
        if (typeof item.arguments === "string") {
          const a = item.arguments;
          if (!best || a.length > best.len) best = { obj: item, key: "arguments", len: a.length };
        }
        if (item.function && typeof item.function === "object" && typeof item.function.arguments === "string") {
          const a = item.function.arguments;
          if (!best || a.length > best.len) best = { obj: item.function, key: "arguments", len: a.length };
        }
      }
      if (t === "function_call_output") {
        if (typeof item.output === "string") {
          const o = item.output;
          if (!best || o.length > best.len) best = { obj: item, key: "output", len: o.length };
        }
      }
    }

    if (!best || best.len <= 0) return false;
    const cut = truncateStringFieldToFit(best.obj, best.key, limit);
    if (cut <= 0) return false;
    truncatedInputChars += cut;
    return true;
  };

  const tryTruncateInstructions = () => {
    if (typeof req.instructions !== "string" || !req.instructions) return false;
    const cut = truncateStringFieldToFit(req, "instructions", limit);
    if (cut <= 0) return false;
    truncatedInstructionChars += cut;
    return true;
  };

  const tryDropTools = () => {
    if (!("tools" in req)) return false;
    if (req.tools == null) return false;
    delete req.tools;
    droppedTools = true;
    return true;
  };

  // Iteratively shrink: drop old turns first, then truncate huge text fields, then drop tools as a last resort.
  let guard = 0;
  while (safeJsonLen(req) > limit && guard++ < 12) {
    if (tryTrimInputWindow()) {
      trimmed = true;
      continue;
    }
    if (tryTruncateLargestInputText()) {
      trimmed = true;
      continue;
    }
    if (tryTruncateInstructions()) {
      trimmed = true;
      continue;
    }
    if (tryDropTools()) {
      trimmed = true;
      continue;
    }
    break;
  }

  droppedUnpairedToolCalls += sanitizeResponsesToolPairs();

  const afterLen = safeJsonLen(req);
  if (afterLen > limit) {
    // Last resort: keep only a minimal request with the latest user input.
    let lastUser = null;
    const input = Array.isArray(req.input) ? req.input : [];
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item || typeof item !== "object") continue;
      if (roleOf(item) === "user") {
        lastUser = item;
        break;
      }
    }

    const modelValue = req.model;
    for (const k of Object.keys(req)) delete req[k];
    if (modelValue !== undefined) req.model = modelValue;
    req.input = lastUser ? [lastUser] : [];

    trimmed = true;
    droppedUnpairedToolCalls += sanitizeResponsesToolPairs();
    while (safeJsonLen(req) > limit && guard++ < 12) {
      if (tryTruncateLargestInputText()) {
        trimmed = true;
        continue;
      }
      if (tryTruncateInstructions()) {
        trimmed = true;
        continue;
      }
      break;
    }
  }

  const finalLen = safeJsonLen(req);
  return {
    ok: true,
    trimmed: trimmed || finalLen !== beforeLen,
    beforeLen,
    afterLen: finalLen,
    droppedTurns,
    droppedSystem,
    droppedTail,
    truncatedInputChars,
    truncatedInstructionChars,
    droppedTools,
    droppedUnpairedToolCalls,
  };
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
  let sawEmptyEventStream = false;

  const retryEmptySseAsNonStream = async (variantObj) => {
    if (!variantObj || typeof variantObj !== "object") return null;

    const headers2 = { ...(headers && typeof headers === "object" ? headers : {}) };
    headers2.accept = "application/json";

    const v0 = variantObj;
    const tries = [];

    const vStreamFalse = { ...v0, stream: false };
    tries.push({ label: "stream:false", value: vStreamFalse });

    const vNoStream = { ...v0 };
    delete vNoStream.stream;
    tries.push({ label: "no-stream-field", value: vNoStream });

    for (let j = 0; j < tries.length; j++) {
      const t = tries[j];
      const body = JSON.stringify(t.value);
      if (debug) {
        logDebug(debug, reqId, "openai upstream empty-sse retry", {
          url: upstreamUrl,
          mode: t.label,
          bodyLen: body.length,
          bodyPreview: previewString(body, 1200),
        });
      }

      let resp2;
      try {
        const t0 = Date.now();
        resp2 = await fetch(upstreamUrl, { method: "POST", headers: headers2, body });
        if (debug) {
          logDebug(debug, reqId, "openai upstream empty-sse retry response", {
            url: upstreamUrl,
            mode: t.label,
            status: resp2.status,
            ok: resp2.ok,
            contentType: resp2.headers.get("content-type") || "",
            elapsedMs: Date.now() - t0,
          });
        }
      } catch (err) {
        if (debug) {
          const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
          logDebug(debug, reqId, "openai upstream empty-sse retry fetch failed", { url: upstreamUrl, mode: t.label, error: message });
        }
        continue;
      }

      // If it still comes back as an empty SSE, keep trying other modes.
      if (resp2.ok && (await isProbablyEmptyEventStream(resp2))) continue;

      // Return the first non-empty response (ok or error) so the caller can handle it.
      return resp2;
    }

    return null;
  };

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
    if (resp.ok && (await isProbablyEmptyEventStream(resp))) {
      sawEmptyEventStream = true;
      if (debug) {
        logDebug(debug, reqId, "openai upstream empty event stream", {
          url: upstreamUrl,
          variant: i,
          status: resp.status,
          contentType: resp.headers.get("content-type") || "",
          contentLength: resp.headers.get("content-length") || "",
        });
      }

      // Some relays incorrectly return `200 text/event-stream` with no events.
      // Retry the same request in non-stream mode to (a) possibly get a proper JSON response or (b) surface a real error body.
      const nonStream = await retryEmptySseAsNonStream(variants[i]);
      if (!nonStream) {
        lastStatus = 502;
        lastText = JSON.stringify(jsonError("Upstream returned an empty event stream", "bad_gateway"));
        if (!firstErr) firstErr = { status: lastStatus, text: lastText };
        continue;
      }

      resp = nonStream;
    }
    if (resp.status >= 400) {
      lastStatus = resp.status;
      lastText = await resp.text().catch(() => "");
      if (!firstErr) firstErr = { status: resp.status, text: lastText };
      if (shouldRetryUpstream(resp.status, lastText) && i + 1 < variants.length) continue;
      exhaustedRetryable = shouldRetryUpstream(resp.status, lastText) && i + 1 >= variants.length;
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
  if (sawEmptyEventStream && firstErr) {
    try {
      return { ok: false, status: firstErr.status, error: JSON.parse(firstErr.text), upstreamUrl };
    } catch {
      return { ok: false, status: firstErr.status, error: jsonError("Upstream returned an empty event stream", "bad_gateway"), upstreamUrl };
    }
  }
  if (exhaustedRetryable && firstErr) {
    try {
      return { ok: false, status: firstErr.status, error: JSON.parse(firstErr.text), upstreamUrl };
    } catch {
      return {
        ok: false,
        status: firstErr.status,
        error: jsonError(firstErr.text || `Upstream error: HTTP ${firstErr.status}`),
        upstreamUrl,
      };
    }
  }
  return { ok: false, status: lastStatus, error: jsonError(lastText || `Upstream error: HTTP ${lastStatus}`), upstreamUrl };
}

function shouldTryNextUpstreamUrl(status) {
  // Gateways often return 403/404/405 for wrong paths; 502 for network/DNS.
  // Some gateways also return 400/422 for unhandled routes.
  return status === 400 || status === 422 || status === 403 || status === 404 || status === 405 || status === 500 || status === 502 || status === 503;
}

async function isProbablyEmptyEventStream(resp) {
  let reader = null;
  try {
    const ct = (resp?.headers?.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream")) return false;
    if (!resp?.body) return true;

    const clone = resp.clone();
    reader = clone.body.getReader();

    let bytesSeen = 0;
    const deadlineMs = 150;
    const startedAt = Date.now();

    const readWithTimeout = (ms) => {
      let timeoutId = null;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ timeout: true }), ms);
      });
      const read = reader.read().then((r) => ({ timeout: false, ...r }));
      return Promise.race([read, timeout]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    };

    while (Date.now() - startedAt < deadlineMs) {
      const remaining = Math.max(0, deadlineMs - (Date.now() - startedAt));
      const first = await readWithTimeout(Math.min(50, remaining));

      // If it hasn't produced anything quickly, assume it's not empty (could just be slow model output).
      if (first?.timeout) return false;

      const { done, value } = first || {};
      if (done) return bytesSeen === 0;

      if (value && typeof value.length === "number") {
        if (value.length > 0) return false;
        // Some runtimes can yield a zero-length chunk; treat as inconclusive and keep reading briefly.
        bytesSeen += value.length;
      }
    }

    return false;
  } catch {
    return false;
  } finally {
    try {
      await reader?.cancel();
    } catch {}
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
    if (sel.ok) return sel;
    if (!firstErr) firstErr = sel;
    if (!shouldTryNextUpstreamUrl(sel.status)) return sel;
  }
  return firstErr || { ok: false, status: 502, error: jsonError("Upstream error", "bad_gateway") };
}

async function sessionCacheUrl(sessionKey) {
  const hex = await sha256Hex(sessionKey);
  return `https://session.rsp2com/${hex}`;
}

async function getSessionPreviousResponseId(sessionKey) {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return null;
    const url = await sessionCacheUrl(sessionKey);
    const resp = await cache.match(url);
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
    const cache = !sessionKey || !responseId || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return;
    const url = await sessionCacheUrl(sessionKey);
    const req = new Request(url, { method: "GET" });
    const resp = new Response(JSON.stringify({ previous_response_id: responseId, updated_at: Date.now() }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "max-age=86400",
      },
    });
    await cache.put(req, resp);
  } catch {
    // ignore
  }
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

function normalizeReasoningEffort(raw) {
  if (typeof raw !== "string") return "";
  const v0 = raw.trim();
  if (!v0) return "";
  const v = v0.toLowerCase();
  if (v === "off" || v === "no" || v === "false" || v === "0" || v === "disable" || v === "disabled") return "";
  return v;
}

function normalizeNonEmptyString(raw) {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return v ? v : "";
}

function normalizePromptCacheRetention(raw) {
  if (typeof raw !== "string") return "";
  const v0 = raw.trim();
  if (!v0) return "";
  const v = v0.toLowerCase();
  if (v === "24h" || v === "24hr" || v === "24hrs" || v === "24hours" || v === "24hour") return "24h";
  if (v === "in-memory" || v === "in_memory" || v === "inmemory" || v === "memory") return "in-memory";
  return v0;
}

function getPromptCachingParams(reqJson) {
  const body = reqJson && typeof reqJson === "object" ? reqJson : {};
  const prompt_cache_retention = normalizePromptCacheRetention(body?.prompt_cache_retention ?? body?.promptCacheRetention);
  const safety_identifier = normalizeNonEmptyString(body?.safety_identifier ?? body?.safetyIdentifier);

  return { prompt_cache_retention, safety_identifier };
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

export async function handleOpenAIRequest({
  request,
  env,
  reqJson,
  model,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
  isTextCompletions,
  extraSystemText,
}) {
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

  const limits = getRsp4CopilotLimits(env);
  const reasoningEffort = getReasoningEffort(reqJson, env);
  const promptCache = getPromptCachingParams(reqJson);
  if (isTextCompletions) {
    const prompt = reqJson.prompt;
    const promptText = Array.isArray(prompt) ? (typeof prompt[0] === "string" ? prompt[0] : "") : typeof prompt === "string" ? prompt : String(prompt ?? "");
    const responsesReq: any = {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: promptText }] }],
    };
    if (reasoningEffort) responsesReq.reasoning = { effort: reasoningEffort };
    if (promptCache.prompt_cache_retention) responsesReq.prompt_cache_retention = promptCache.prompt_cache_retention;
    if (promptCache.safety_identifier) responsesReq.safety_identifier = promptCache.safety_identifier;
    if (Number.isInteger(reqJson.max_tokens)) responsesReq.max_output_tokens = reqJson.max_tokens;
    if (Number.isInteger(reqJson.max_completion_tokens)) responsesReq.max_output_tokens = reqJson.max_completion_tokens;
    applyTemperatureTopPFromRequest(reqJson, responsesReq);
    if ("stop" in reqJson) responsesReq.stop = reqJson.stop;

    const maxInputChars = Number.isInteger(limits?.maxInputChars) ? limits.maxInputChars : null;
    if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
      const trimRes = trimOpenAIResponsesRequestToMaxChars(responsesReq, maxInputChars);
      if (debug && trimRes.trimmed) {
        logDebug(debug, reqId, "openai completions trimmed", {
          beforeLen: trimRes.beforeLen,
          afterLen: trimRes.afterLen,
          droppedTurns: trimRes.droppedTurns,
          droppedSystem: trimRes.droppedSystem,
          droppedTail: trimRes.droppedTail,
          truncatedInputChars: trimRes.truncatedInputChars,
          truncatedInstructionChars: trimRes.truncatedInstructionChars,
          droppedTools: trimRes.droppedTools,
          droppedUnpairedToolCalls: trimRes.droppedUnpairedToolCalls,
        });
      }
    }

    const variants0 = responsesReqVariants(responsesReq, upstreamStream);
    const variants = [];
    if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
      for (const v0 of variants0) {
        if (!v0 || typeof v0 !== "object") continue;
        const v = { ...v0 };
        trimOpenAIResponsesRequestToMaxChars(v, maxInputChars);
        variants.push(v);
      }
    } else {
      variants.push(...variants0);
    }
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
            if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string" && payload.text) {
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

  const incomingStats = measureOpenAIChatMessages(messages);
  const withinLimits =
    (limits.maxTurns <= 0 || incomingStats.turns <= limits.maxTurns) &&
    (limits.maxMessages <= 0 || incomingStats.messages <= limits.maxMessages) &&
    (limits.maxInputChars <= 0 || incomingStats.inputChars <= limits.maxInputChars);

  const trimRes = trimOpenAIChatMessages(messages, limits);
  if (!trimRes.ok) return jsonResponse(400, jsonError(trimRes.error));
  const messagesForUpstream = trimRes.messages;
  if (debug && trimRes.trimmed) {
    logDebug(debug, reqId, "chat history trimmed", {
      before: trimRes.before,
      after: trimRes.after,
      droppedTurns: trimRes.droppedTurns,
      droppedSystem: trimRes.droppedSystem,
    });
  }

  const sessionKey = getSessionKey(request, reqJson, token);
  if (debug) {
    logDebug(debug, reqId, "openai session", {
      sessionKey: sessionKey ? maskSecret(sessionKey) : "",
      multiTurnPossible: hasAssistantMessage(messagesForUpstream),
      withinLimits,
      incoming: incomingStats,
      trimmed: trimRes.trimmed,
    });
  }

  const { instructions, input } = chatMessagesToResponsesInput(messagesForUpstream);
  if (!input.length) return jsonResponse(400, jsonError("messages must include at least one non-system message"));

  const effectiveInstructions = appendInstructions(instructions, extraSystemText);

  const fullReq: any = {
    model,
    input,
  };
  if (reasoningEffort) fullReq.reasoning = { effort: reasoningEffort };
  if (promptCache.prompt_cache_retention) fullReq.prompt_cache_retention = promptCache.prompt_cache_retention;
  if (promptCache.safety_identifier) fullReq.safety_identifier = promptCache.safety_identifier;
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

  const lastAssistantIdx = indexOfLastAssistantMessage(messagesForUpstream);
  const multiTurn = withinLimits && lastAssistantIdx >= 0;
  const prevId = multiTurn ? await getSessionPreviousResponseId(sessionKey) : null;
  const deltaMessages = prevId && lastAssistantIdx >= 0 ? messagesForUpstream.slice(lastAssistantIdx + 1) : [];
  const deltaConv = deltaMessages.length ? chatMessagesToResponsesInput(deltaMessages) : { input: [] };

  const prevReq: any =
    prevId && Array.isArray(deltaConv.input) && deltaConv.input.length
      ? {
          model,
          input: deltaConv.input,
          previous_response_id: prevId,
        }
      : null;
  if (prevReq) {
    if (reasoningEffort) prevReq.reasoning = { effort: reasoningEffort };
    if (promptCache.prompt_cache_retention) prevReq.prompt_cache_retention = promptCache.prompt_cache_retention;
    if (promptCache.safety_identifier) prevReq.safety_identifier = promptCache.safety_identifier;
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
      totalMessagesCount: messagesForUpstream.length,
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
    if (debug) logDebug(debug, reqId, "openai fallback to full history (previous_response_id rejected)", { status: sel.status });
    const fallbackVariants = responsesReqVariants(fullReq, upstreamStream);
    const sel2 = await selectUpstreamResponseAny(upstreamUrls, headers, fallbackVariants, debug, reqId);
    // Always prefer the fallback result (even if it also failed), since the original error
    // about `previous_response_id` is misleading when the real issue is upstream compatibility.
    sel = sel2;
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
	    let reasoningText = "";
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
        if ((evt === "response.reasoning.delta" || evt === "response.reasoning_summary.delta") && typeof payload.delta === "string") {
          reasoningText += payload.delta;
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
	        reasoningLen: reasoningText.length,
	        reasoningPreview: previewString(reasoningText, 600),
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
	          message: {
	            role: "assistant",
	            content: contentValue,
	            ...(reasoningText && reasoningText.trim() ? { reasoning_content: reasoningText } : {}),
	            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
	          },
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
      const fn: any = {};
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

    const emitReasoningDelta = async (deltaText) => {
      if (typeof deltaText !== "string" || !deltaText) return;
      await ensureAssistantRoleSent();
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: outModel,
        choices: [{ index: 0, delta: { reasoning_content: deltaText }, finish_reason: null }],
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
              await upsertToolCall(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments, "full");
            }
            continue;
          }

          if ((evt === "response.reasoning.delta" || evt === "response.reasoning_summary.delta") && typeof payload.delta === "string" && payload.delta) {
            await emitReasoningDelta(payload.delta);
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
}

export async function handleOpenAIChatCompletionsUpstream({
  request,
  env,
  reqJson,
  model,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
  extraSystemText,
}) {
  const upstreamBase = normalizeAuthValue(env?.OPENAI_BASE_URL);
  if (!upstreamBase) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_BASE_URL", "server_error"));
  const upstreamKey = normalizeAuthValue(env?.OPENAI_API_KEY);
  if (!upstreamKey) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_API_KEY", "server_error"));

  const upstreamUrls = buildChatCompletionsUrls(upstreamBase, env?.OPENAI_CHAT_COMPLETIONS_PATH);
  if (!upstreamUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid OPENAI_BASE_URL", "server_error"));
  if (debug) logDebug(debug, reqId, "openai chat-completions upstream urls", { urls: upstreamUrls });

  const body = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  body.model = model;
  body.stream = Boolean(stream);
  for (const k of Object.keys(body)) {
    if (k.startsWith("__")) delete body[k];
  }

  const headers = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${upstreamKey}`,
    "x-api-key": upstreamKey,
    "x-goog-api-key": upstreamKey,
  };
  if (debug) logDebug(debug, reqId, "openai chat-completions upstream headers", { headers: redactHeadersForLog(headers) });

  if (extraSystemText && Array.isArray(body.messages)) {
    body.messages = [{ role: "system", content: extraSystemText }, ...body.messages];
  }

  void token;
  void request;
  void path;
  void startedAt;

  const sel = await selectUpstreamResponseAny(upstreamUrls, headers, [body], debug, reqId);
  if (!sel.ok && debug) {
    logDebug(debug, reqId, "openai chat-completions upstream failed", { path, upstreamUrl: sel.upstreamUrl, status: sel.status, error: sel.error });
  }
  if (!sel.ok) return jsonResponse(sel.status, sel.error);

  const resp = sel.resp;
  if (stream) {
    return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
  }

  const text = await resp.text();
  const outHeaders = { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" };
  return new Response(text, { status: resp.status, headers: outHeaders });
}

export async function handleOpenAIResponsesUpstream({
  request,
  env,
  reqJson,
  upstreamModel,
  outModel,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
}: {
  request: Request;
  env: any;
  reqJson: any;
  upstreamModel: string;
  outModel: string;
  stream: boolean;
  token: string;
  debug: boolean;
  reqId: string;
  path: string;
  startedAt: number;
}): Promise<Response> {
  const upstreamBase = normalizeAuthValue(env?.OPENAI_BASE_URL);
  if (!upstreamBase) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_BASE_URL", "server_error"));
  const upstreamKey = normalizeAuthValue(env?.OPENAI_API_KEY);
  if (!upstreamKey) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_API_KEY", "server_error"));

  const limits = getRsp4CopilotLimits(env);

  const upstreamUrls = buildUpstreamUrls(upstreamBase, env?.RESP_RESPONSES_PATH);
  if (!upstreamUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid OPENAI_BASE_URL", "server_error"));
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

  const bodyBase = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  bodyBase.model = upstreamModel;
  bodyBase.stream = upstreamStream;
  for (const k of Object.keys(bodyBase)) {
    if (k.startsWith("__")) delete bodyBase[k];
  }

  const reasoningEffort = getReasoningEffort(bodyBase, env);
  if (reasoningEffort) {
    const r0 = bodyBase.reasoning;
    if (r0 && typeof r0 === "object" && !Array.isArray(r0)) bodyBase.reasoning = { ...r0, effort: reasoningEffort };
    else bodyBase.reasoning = { effort: reasoningEffort };
  }

  const maxInputChars = Number.isInteger(limits?.maxInputChars) ? limits.maxInputChars : null;
  if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
    const trimRes = trimOpenAIResponsesRequestToMaxChars(bodyBase, maxInputChars);
    if (debug && trimRes.trimmed) {
      logDebug(debug, reqId, "openai responses trimmed", {
        beforeLen: trimRes.beforeLen,
        afterLen: trimRes.afterLen,
        droppedTurns: trimRes.droppedTurns,
        droppedSystem: trimRes.droppedSystem,
        droppedTail: trimRes.droppedTail,
        truncatedInputChars: trimRes.truncatedInputChars,
        truncatedInstructionChars: trimRes.truncatedInstructionChars,
        droppedTools: trimRes.droppedTools,
        droppedUnpairedToolCalls: trimRes.droppedUnpairedToolCalls,
      });
    }
  }

  void token;
  void request;
  void path;
  void startedAt;

  const variants0 = responsesReqVariants(bodyBase, upstreamStream);
  const variants = [];
  if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
    for (const v0 of variants0) {
      if (!v0 || typeof v0 !== "object") continue;
      const v = { ...v0 };
      trimOpenAIResponsesRequestToMaxChars(v, maxInputChars);
      variants.push(v);
    }
  } else {
    variants.push(...variants0);
  }
  if (debug) {
    const reqLog = safeJsonStringifyForLog(bodyBase);
    logDebug(debug, reqId, "openai responses request", {
      stream: Boolean(stream),
      upstreamStream,
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

  const resp = sel.resp;
  if (stream) {
    return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (!resp.body || !ct.includes("text/event-stream")) {
    const text = await resp.text();
    const outHeaders = { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" };
    return new Response(text, { status: resp.status, headers: outHeaders });
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let raw = "";
  let responseObj: any = null;
  let sawDataLine = false;
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
      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const evt = payload?.type;
      if ((evt === "response.completed" || evt === "response.failed") && payload?.response && typeof payload.response === "object") {
        responseObj = payload.response;
        finished = true;
        break;
      }
    }
  }
  try {
    await reader.cancel();
  } catch {}

  if (!responseObj && (!sawDataLine || raw.trim())) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") responseObj = obj?.response && typeof obj.response === "object" ? obj.response : obj;
    } catch {
      // ignore
    }
  }

  if (!responseObj || typeof responseObj !== "object") {
    if (debug) logDebug(debug, reqId, "openai responses parse failed", { sawDataLine, rawPreview: previewString(raw, 1200) });
    return jsonResponse(502, jsonError("Upstream returned an unreadable event stream", "bad_gateway"));
  }

  if (typeof outModel === "string" && outModel.trim()) responseObj.model = outModel.trim();

  return jsonResponse(200, responseObj);
}
