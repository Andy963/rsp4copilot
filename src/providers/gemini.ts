import {
  appendInstructions,
  encodeSseData,
  getSessionKey,
  getRsp4CopilotLimits,
  jsonError,
  jsonResponse,
  joinPathPrefix,
  logDebug,
  maskSecret,
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

export function isGeminiModelId(modelId) {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "gemini") return true;
  if (v === "gemini-default") return true;
  if (v.startsWith("gemini-")) return true;
  if (v.includes("/gemini")) return true;
  if (v.includes("gemini-")) return true;
  return false;
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

function jsonSchemaToGeminiSchema(jsonSchema, rootSchema = jsonSchema, refStack = undefined) {
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
  const int64FieldNames = new Set(["maxItems", "minItems", "minLength", "maxLength", "minProperties", "maxProperties"]);

  const out: any = {};

  const input = { ...jsonSchema };

  // Gemini Schema is a subset of OpenAPI 3.0 and does not support exclusiveMinimum/exclusiveMaximum.
  // Convert JSON Schema 2019+/2020 numeric exclusives (and OpenAPI boolean exclusives) into inclusive bounds.
  const typeHint = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  const isIntegerType = typeHint === "integer";
  const bumpEpsilon = (n) => Number.EPSILON * Math.max(1, Math.abs(Number(n)));
  const bumpUp = (n) => (isIntegerType ? Math.floor(Number(n)) + 1 : Number(n) + bumpEpsilon(n));
  const bumpDown = (n) => (isIntegerType ? Math.ceil(Number(n)) - 1 : Number(n) - bumpEpsilon(n));

  if (typeof input.exclusiveMinimum === "number" && Number.isFinite(input.exclusiveMinimum)) {
    const candidate = bumpUp(input.exclusiveMinimum);
    if (typeof input.minimum === "number" && Number.isFinite(input.minimum)) input.minimum = Math.max(input.minimum, candidate);
    else input.minimum = candidate;
    delete input.exclusiveMinimum;
  } else if (input.exclusiveMinimum === true) {
    if (typeof input.minimum === "number" && Number.isFinite(input.minimum)) input.minimum = bumpUp(input.minimum);
    delete input.exclusiveMinimum;
  } else if ("exclusiveMinimum" in input) {
    delete input.exclusiveMinimum;
  }

  if (typeof input.exclusiveMaximum === "number" && Number.isFinite(input.exclusiveMaximum)) {
    const candidate = bumpDown(input.exclusiveMaximum);
    if (typeof input.maximum === "number" && Number.isFinite(input.maximum)) input.maximum = Math.min(input.maximum, candidate);
    else input.maximum = candidate;
    delete input.exclusiveMaximum;
  } else if (input.exclusiveMaximum === true) {
    if (typeof input.maximum === "number" && Number.isFinite(input.maximum)) input.maximum = bumpDown(input.maximum);
    delete input.exclusiveMaximum;
  } else if ("exclusiveMaximum" in input) {
    delete input.exclusiveMaximum;
  }

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
    if (k === "examples") continue;
    if (k === "allOf") continue;

    if (k === "type") {
      if (typeof v !== "string") continue;
      if (v === "null") continue;
      out.type = String(v).toUpperCase();
      continue;
    }

    if (k === "const") {
      if (!("enum" in out) && typeof v === "string") out.enum = [v];
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

    if (k === "required" || k === "propertyOrdering") {
      if (Array.isArray(v)) {
        const list = v.filter((x) => typeof x === "string" && x.trim());
        if (list.length) out[k] = list;
      }
      continue;
    }

    if (k === "enum") {
      if (Array.isArray(v)) {
        const list = v.filter((x) => typeof x === "string");
        if (list.length) out.enum = list;
      }
      continue;
    }

    if (k === "format" || k === "title" || k === "description" || k === "pattern") {
      if (typeof v === "string" && v.trim()) out[k] = v;
      continue;
    }

    if (k === "nullable") {
      if (typeof v === "boolean") out.nullable = v;
      continue;
    }

    if (k === "minimum" || k === "maximum") {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      continue;
    }

    if (int64FieldNames.has(k)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = String(Math.trunc(v));
      else if (typeof v === "string" && v.trim()) out[k] = v.trim();
      continue;
    }

    if (k === "default" || k === "example") {
      out[k] = v;
      continue;
    }
  }

  // Gemini Schema types are enum-like uppercase strings; if absent but properties exist, treat as OBJECT.
  if (!out.type && out.properties && typeof out.properties === "object") out.type = "OBJECT";
  return out;
}

function bytesToBase64(bytes) {
  if (!bytes) return "";
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
    if (!t || !t.trim()) return;
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
    const decl: any = { name };
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

function normalizeGeminiContents(rawContents, { requireUser = false } = {}) {
  const list = Array.isArray(rawContents) ? rawContents : [];
  const out = [];

  for (const c0 of list) {
    if (!c0 || typeof c0 !== "object") continue;
    const c = c0 as any;

    const roleRaw = typeof c.role === "string" ? c.role : "";
    const role = roleRaw && roleRaw.trim() ? roleRaw.trim() : "user";

    const partsIn = Array.isArray(c.parts) ? c.parts : [];
    const partsOut = [];

    for (const p0 of partsIn) {
      if (!p0 || typeof p0 !== "object") continue;
      const p = p0 as any;

      if (typeof p.text === "string") {
        if (p.text.trim()) partsOut.push(p0);
        continue;
      }

      const inlineData = p.inlineData && typeof p.inlineData === "object" ? p.inlineData : null;
      if (inlineData) {
        const data = typeof inlineData.data === "string" ? inlineData.data.trim() : "";
        if (data) partsOut.push(p0);
        continue;
      }

      const fileData = p.fileData && typeof p.fileData === "object" ? p.fileData : null;
      if (fileData) {
        const fileUri = typeof fileData.fileUri === "string" ? fileData.fileUri.trim() : "";
        if (fileUri) partsOut.push(p0);
        continue;
      }

      const fc = p.functionCall && typeof p.functionCall === "object" ? p.functionCall : null;
      if (fc) {
        const name = typeof fc.name === "string" ? fc.name.trim() : "";
        if (name) partsOut.push(p0);
        continue;
      }

      const fr = p.functionResponse && typeof p.functionResponse === "object" ? p.functionResponse : null;
      if (fr) {
        const name = typeof fr.name === "string" ? fr.name.trim() : "";
        if (name) partsOut.push(p0);
        continue;
      }

      // Unknown part type: keep it if it's not an empty object.
      if (Object.keys(p).length) partsOut.push(p0);
    }

    if (!partsOut.length) continue;
    out.push({ ...c0, role, parts: partsOut });
  }

  if (!out.length) {
    return { ok: false, contents: [], error: "At least one non-system message is required (contents array is empty)" };
  }

  if (requireUser) {
    const hasUser = out.some((c) => typeof (c as any)?.role === "string" && String((c as any).role).trim().toLowerCase() === "user");
    if (!hasUser) return { ok: false, contents: [], error: "At least one user message is required" };
  }

  return { ok: true, contents: out, error: "" };
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
    const cachedName =
      callId && sigCache && typeof sigCache === "object" && sigCache[callId] && typeof sigCache[callId].name === "string"
        ? String(sigCache[callId].name).trim()
        : "";
    const name = mappedName || cachedName || fallbackName || "";

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

    // If we can't map a tool name (e.g. delta-history only contains tool results), degrade to plain text
    // instead of dropping the entire turn, otherwise `contents` may become empty and Gemini will 400.
    if (!name) {
      const label = callId ? `Tool result (call_id=${callId}):` : "Tool result:";
      return { callId, part: { text: `${label}\n${rawText}` } };
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
        const fcPart: any = {
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
  const generationConfig: any = {};
  // Only copy serializable numeric values; callers may include keys with `undefined` (e.g. Responses->Chat conversion).
  if (typeof reqJson?.temperature === "number" && Number.isFinite(reqJson.temperature)) generationConfig.temperature = reqJson.temperature;
  if (typeof reqJson?.top_p === "number" && Number.isFinite(reqJson.top_p)) generationConfig.topP = reqJson.top_p;
  if (typeof reqJson?.presence_penalty === "number" && Number.isFinite(reqJson.presence_penalty)) generationConfig.presencePenalty = reqJson.presence_penalty;
  if (typeof reqJson?.frequency_penalty === "number" && Number.isFinite(reqJson.frequency_penalty)) generationConfig.frequencyPenalty = reqJson.frequency_penalty;

  const maxTokens = Number.isInteger(reqJson.max_tokens)
    ? reqJson.max_tokens
    : Number.isInteger(reqJson.max_completion_tokens)
      ? reqJson.max_completion_tokens
      : null;
  const defaultMaxOutputTokens = (() => {
    const candidates = [env?.GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, env?.GEMINI_MAX_OUTPUT_TOKENS, env?.GEMINI_MAX_TOKENS];
    for (const v of candidates) {
      const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return 65536;
  })();
  // Some Gemini gateways default `maxOutputTokens` to 0 when omitted; always set a safe default.
  generationConfig.maxOutputTokens = Number.isInteger(maxTokens) ? maxTokens : defaultMaxOutputTokens;

  // Prefer enabling Gemini thought summaries so the client can render a "Thinking" block.
  // (This is ignored by models that don't support it; callers can override via upstream config if needed.)
  if (!("thinkingConfig" in generationConfig)) {
    generationConfig.thinkingConfig = { includeThoughts: true };
  } else {
    const tc = generationConfig.thinkingConfig;
    if (tc && typeof tc === "object" && !Array.isArray(tc)) {
      if (!("includeThoughts" in tc)) (tc as any).includeThoughts = true;
    } else if (tc == null) {
      generationConfig.thinkingConfig = { includeThoughts: true };
    }
  }

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
  let reasoning = "";
  let thoughtSummarySoFar = "";
  const toolCalls = [];

  // Track the most recent thought/thought_signature for the next function call (2025 API)
  let pendingThought = "";
  let pendingThoughtSignature = "";

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;

    // Thought summary text comes through as `text` with `thought: true`
    if (p.thought === true && typeof p.text === "string") {
      const thoughtSummaryText = p.text;
      if (thoughtSummaryText) {
        if (thoughtSummaryText.startsWith(thoughtSummarySoFar)) {
          thoughtSummarySoFar = thoughtSummaryText;
        } else if (thoughtSummarySoFar.startsWith(thoughtSummaryText)) {
          // ignore (already have a longer buffer)
        } else {
          thoughtSummarySoFar += thoughtSummaryText;
        }
      }
      continue;
    }

    // Check for functionCall first (2025 API: thoughtSignature is sibling to functionCall in same part)
    const fc = p.functionCall;
    if (fc && typeof fc === "object") {
      const name = typeof fc.name === "string" ? fc.name.trim() : "";
      if (!name) continue;
      const argsStr = geminiArgsToJsonString(fc.args);
      const tcItem: any = {
        id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: { name, arguments: argsStr && argsStr.trim() ? argsStr : "{}" },
      };

      // Extract thought_signature from the same part (2025 API: thoughtSignature is sibling to functionCall)
      const thoughtSig =
        p.thoughtSignature || p.thought_signature || fc.thoughtSignature || fc.thought_signature || pendingThoughtSignature || "";
      const thought = p.thought || fc.thought || pendingThought || "";

      if (typeof thoughtSig === "string" && thoughtSig.trim()) {
        tcItem.thought_signature = thoughtSig.trim();
      }
      if (typeof thought === "string" && thought) {
        tcItem.thought = thought;
        reasoning += thought;
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
      if (typeof p.thought === "string") {
        pendingThought = p.thought;
        if (p.thought) reasoning += p.thought;
      }
      if (typeof p.thought_signature === "string") pendingThoughtSignature = p.thought_signature;
      if (typeof p.thoughtSignature === "string") pendingThoughtSignature = p.thoughtSignature;
      continue;
    }
  }

  const finishReasonRaw = cand?.finishReason ?? cand?.finish_reason;
  const finish_reason = geminiFinishReasonToOpenai(finishReasonRaw, toolCalls.length > 0);
  const combinedReasoning = [thoughtSummarySoFar, reasoning].map((v) => String(v || "").trim()).filter(Boolean).join("\n\n");
  return { text, reasoning: combinedReasoning, toolCalls, finish_reason, usage: geminiUsageToOpenaiUsage(root?.usageMetadata) };
}

async function thoughtSignatureCacheUrl(sessionKey) {
  const hex = await sha256Hex(`thought_sig_${sessionKey}`);
  return `https://thought-sig.rsp2com/${hex}`;
}

async function getThoughtSignatureCache(sessionKey) {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return {};
    const url = await thoughtSignatureCacheUrl(sessionKey);
    const resp = await cache.match(url);
    if (!resp) return {};
    const data = await resp.json().catch(() => null);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function setThoughtSignatureCache(sessionKey, callId, thoughtSignature, thought, name) {
  try {
    const cache = !sessionKey || !callId || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return;
    // Get existing cache
    const existing: any = await getThoughtSignatureCache(sessionKey);
    // Add new entry
    existing[callId] = {
      thought_signature: thoughtSignature || "",
      thought: thought || "",
      name: name || "",
      updated_at: Date.now(),
    };
    // Limit cache size (keep last 100 entries)
    const entries: any[] = Object.entries(existing);
    if (entries.length > 100) {
      entries.sort((a, b) => ((b?.[1]?.updated_at as any) || 0) - ((a?.[1]?.updated_at as any) || 0));
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
    await cache.put(req, resp);
  } catch {
    // ignore
  }
}

export async function handleGeminiChatCompletions({ request, env, reqJson, model, stream, token, debug, reqId, extraSystemText }) {
  const geminiBase = normalizeAuthValue(env.GEMINI_BASE_URL);
  const geminiKey = normalizeAuthValue(env.GEMINI_API_KEY);
  if (!geminiBase) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_BASE_URL", "server_error"));
  if (!geminiKey) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_API_KEY", "server_error"));

  const geminiModelId = normalizeGeminiModelId(model, env);
  const geminiUrl = buildGeminiGenerateContentUrl(geminiBase, geminiModelId, stream);
  if (!geminiUrl) return jsonResponse(500, jsonError("Server misconfigured: invalid GEMINI_BASE_URL", "server_error"));

  const sessionKey = getSessionKey(request, reqJson, token);
  const thoughtSigCache = sessionKey ? await getThoughtSignatureCache(sessionKey) : {};

  const limits = getRsp4CopilotLimits(env);
  const trimRes = trimOpenAIChatMessages(reqJson.messages || [], limits);
  if (!trimRes.ok) return jsonResponse(400, jsonError(trimRes.error));
  if (debug && trimRes.trimmed) {
    logDebug(debug, reqId, "chat history trimmed", {
      before: trimRes.before,
      after: trimRes.after,
      droppedTurns: trimRes.droppedTurns,
      droppedSystem: trimRes.droppedSystem,
    });
  }
  const reqJsonForUpstream = trimRes.trimmed ? { ...reqJson, messages: trimRes.messages } : reqJson;

  let geminiBody;
  try {
    geminiBody = await openaiChatToGeminiRequest(reqJsonForUpstream, env, fetch, extraSystemText, thoughtSigCache);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to build Gemini request";
    return jsonResponse(400, jsonError(`Invalid request: ${message}`));
  }

  // Validate that contents are non-empty and usable (Gemini requires at least one user turn).
  const normContents = normalizeGeminiContents(geminiBody?.contents, { requireUser: true });
  if (!normContents.ok) return jsonResponse(400, jsonError(normContents.error, "invalid_request_error"));
  geminiBody.contents = normContents.contents;

  // Match Gemini's official auth style (and oai-compatible-copilot): API key in `x-goog-api-key`.
  // Some proxies mis-handle `Authorization` for Gemini and may return empty candidates.
  const geminiHeaders = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "rsp4copilot",
    "x-goog-api-key": geminiKey,
  };
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) geminiHeaders["x-session-id"] = xSessionId.trim();

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
    } catch { }
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
    const parseGeminiJson = async (resp) => {
      let gjson = null;
      try {
        gjson = await resp.json();
      } catch {
        return { ok: false, gjson: null, extracted: null, error: "Gemini upstream returned invalid JSON" };
      }
      const extracted = geminiExtractTextAndToolCalls(gjson);
      return { ok: true, gjson, extracted, error: "" };
    };

    const shouldRetryEmpty = (extracted) => {
      if (!extracted || typeof extracted !== "object") return false;
      const text0 = typeof extracted.text === "string" ? extracted.text.trim() : "";
      const reasoning0 = typeof extracted.reasoning === "string" ? extracted.reasoning.trim() : "";
      const toolCalls0 = Array.isArray(extracted.toolCalls) ? extracted.toolCalls : [];
      return !text0 && toolCalls0.length === 0 && !reasoning0;
    };

    const primaryParsed = await parseGeminiJson(gemResp);
    if (!primaryParsed.ok) {
      return jsonResponse(502, jsonError(primaryParsed.error || "Gemini upstream returned invalid JSON", "bad_gateway"));
    }

    let { extracted } = primaryParsed;
    let gjson = primaryParsed.gjson;

    // Some Gemini gateways silently drop unsupported `generationConfig` fields (e.g. too-large `maxOutputTokens`),
    // resulting in a 200 response with empty candidates. Retry with smaller caps and/or without thought summaries.
    if (shouldRetryEmpty(extracted)) {
      const originalMax = geminiBody?.generationConfig?.maxOutputTokens;
      const originalThinkingCfg = geminiBody?.generationConfig?.thinkingConfig;
      const retryMaxValues = [8192, 4096, 2048];

      const cloneBody = (body) => {
        try {
          return JSON.parse(JSON.stringify(body));
        } catch {
          return null;
        }
      };

      const tryVariant = async (label, bodyOverride) => {
        if (!bodyOverride || typeof bodyOverride !== "object") return null;
        try {
          const resp2 = await fetch(geminiUrl, { method: "POST", headers: geminiHeaders, body: JSON.stringify(bodyOverride) });
          if (!resp2.ok) return null;
          const parsed2 = await parseGeminiJson(resp2);
          if (!parsed2.ok) return null;
          if (debug) {
            logDebug(debug, reqId, "gemini retry result", {
              label,
              originalMaxOutputTokens: originalMax ?? null,
              retryMaxOutputTokens: bodyOverride?.generationConfig?.maxOutputTokens ?? null,
              retryIncludeThoughts: bodyOverride?.generationConfig?.thinkingConfig?.includeThoughts ?? null,
              textLen: typeof parsed2.extracted?.text === "string" ? parsed2.extracted.text.length : 0,
              toolCalls: Array.isArray(parsed2.extracted?.toolCalls) ? parsed2.extracted.toolCalls.length : 0,
            });
          }
          return parsed2;
        } catch {
          return null;
        }
      };

      for (const maxOut of retryMaxValues) {
        const b1 = cloneBody(geminiBody);
        if (!b1) continue;
        if (!b1.generationConfig || typeof b1.generationConfig !== "object") b1.generationConfig = {};
        b1.generationConfig.maxOutputTokens = maxOut;
        // Keep thoughts enabled for this retry.
        if (!b1.generationConfig.thinkingConfig || typeof b1.generationConfig.thinkingConfig !== "object") {
          b1.generationConfig.thinkingConfig = { includeThoughts: true };
        } else if (!("includeThoughts" in b1.generationConfig.thinkingConfig)) {
          b1.generationConfig.thinkingConfig.includeThoughts = true;
        }

        const retryRes = await tryVariant(`maxOutputTokens=${maxOut}`, b1);
        if (retryRes && !shouldRetryEmpty(retryRes.extracted)) {
          gjson = retryRes.gjson;
          extracted = retryRes.extracted;
          break;
        }
      }

      // Last resort: disable thought summaries (some gateways reject thinkingConfig).
      if (shouldRetryEmpty(extracted) && originalThinkingCfg) {
        const b2Base = cloneBody(geminiBody);
        if (b2Base?.generationConfig && typeof b2Base.generationConfig === "object") {
          delete b2Base.generationConfig.thinkingConfig;
        }

        // Try without thinkingConfig first (keep original maxOutputTokens).
        const retryRes0 = await tryVariant("disableThinkingConfig", b2Base);
        if (retryRes0 && !shouldRetryEmpty(retryRes0.extracted)) {
          gjson = retryRes0.gjson;
          extracted = retryRes0.extracted;
        } else {
          // If still empty, also cap maxOutputTokens (some gateways treat large values as 0 output).
          for (const maxOut of retryMaxValues) {
            const b2 = cloneBody(b2Base);
            if (!b2) continue;
            if (!b2.generationConfig || typeof b2.generationConfig !== "object") b2.generationConfig = {};
            b2.generationConfig.maxOutputTokens = maxOut;
            const retryRes = await tryVariant(`disableThinkingConfig maxOutputTokens=${maxOut}`, b2);
            if (retryRes && !shouldRetryEmpty(retryRes.extracted)) {
              gjson = retryRes.gjson;
              extracted = retryRes.extracted;
              break;
            }
          }
        }
      }
    }

    // Some gateways only implement `streamGenerateContent` correctly. If the JSON endpoint is still empty,
    // retry once via SSE and assemble a non-stream Chat Completions response.
    if (shouldRetryEmpty(extracted)) {
      const streamUrl = buildGeminiGenerateContentUrl(geminiBase, geminiModelId, true);
      const streamHeaders = { ...geminiHeaders, Accept: "text/event-stream" };

      const tryStreamFallback = async (label, bodyOverride) => {
        if (!streamUrl || !bodyOverride || typeof bodyOverride !== "object") return null;
        try {
          const resp2 = await fetch(streamUrl, { method: "POST", headers: streamHeaders, body: JSON.stringify(bodyOverride) });
          if (!resp2.ok || !resp2.body) {
            if (debug) {
              const errText = await resp2.text().catch(() => "");
              logDebug(debug, reqId, "gemini stream fallback upstream error", {
                label,
                status: resp2.status,
                contentType: resp2.headers.get("content-type") || "",
                errorPreview: previewString(errText, 1200),
              });
            }
            return null;
          }

          const toolCallKeyToMeta = new Map(); // key -> { id, name, args, thought_signature?, thought? }
          let pendingThoughtSoFar = "";
          let thoughtSummarySoFar = "";
          let lastFinishReason = "";
          let textSoFar = "";
          let usageMetadata: any = null;
          let bytesIn0 = 0;
          let sseDataLines0 = 0;

          const reader = resp2.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let raw = "";
          let sawDataLine = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            bytesIn0 += chunkText.length;
            raw += chunkText;
            buf += chunkText;
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              sseDataLines0++;
              sawDataLine = true;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === "[DONE]") {
                try {
                  await reader.cancel();
                } catch { }
                buf = "";
                break;
              }
              let payload;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }

              // Keep the latest usageMetadata if present.
              if (payload?.usageMetadata && typeof payload.usageMetadata === "object") usageMetadata = payload.usageMetadata;

              const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
              const cand = candidates.length ? candidates[0] : null;
              const fr = cand?.finishReason ?? cand?.finish_reason;
              if (typeof fr === "string" && fr.trim()) lastFinishReason = fr.trim();

              const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];

              // Text (exclude thought summary parts)
              const textJoined = parts
                .map((p) => {
                  if (!p || typeof p !== "object") return "";
                  if ((p as any).thought === true) return "";
                  return typeof (p as any).text === "string" ? (p as any).text : "";
                })
                .filter(Boolean)
                .join("");

              if (textJoined) {
                if (textJoined.startsWith(textSoFar)) {
                  textSoFar = textJoined;
                } else if (textSoFar.startsWith(textJoined)) {
                  // ignore (already have a longer buffer)
                } else {
                  textSoFar += textJoined;
                }
              }

              for (const p of parts) {
                if (!p || typeof p !== "object") continue;

                // Thought summary text comes through as `text` with `thought: true`.
                if ((p as any).thought === true && typeof (p as any).text === "string") {
                  const thoughtSummaryText = (p as any).text;
                  if (thoughtSummaryText) {
                    if (thoughtSummaryText.startsWith(thoughtSummarySoFar)) {
                      thoughtSummarySoFar = thoughtSummaryText;
                    } else if (thoughtSummarySoFar.startsWith(thoughtSummaryText)) {
                      // ignore
                    } else {
                      thoughtSummarySoFar += thoughtSummaryText;
                    }
                  }
                  continue;
                }

                const fc = (p as any).functionCall;
                if (fc && typeof fc === "object") {
                  const name = typeof fc.name === "string" ? fc.name.trim() : "";
                  if (!name) continue;
                  const argsStr = geminiArgsToJsonString(fc.args);
                  const key = `${name}\n${argsStr}`;

                  if (!toolCallKeyToMeta.has(key)) {
                    const meta: any = {
                      id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
                      name,
                      args: "",
                    };
                    toolCallKeyToMeta.set(key, meta);
                  }
                  const meta = toolCallKeyToMeta.get(key);
                  meta.args = argsStr && argsStr.trim() ? argsStr : "{}";

                  const thoughtSigRaw =
                    (p as any).thoughtSignature ||
                    (p as any).thought_signature ||
                    (fc as any).thoughtSignature ||
                    (fc as any).thought_signature ||
                    "";
                  const thoughtRaw = (p as any).thought || (fc as any).thought || "";

                  if (typeof thoughtSigRaw === "string" && thoughtSigRaw.trim()) meta.thought_signature = thoughtSigRaw.trim();
                  if (typeof thoughtRaw === "string") meta.thought = thoughtRaw;

                  if (typeof thoughtRaw === "string" && thoughtRaw) {
                    if (thoughtRaw.startsWith(pendingThoughtSoFar)) {
                      pendingThoughtSoFar = thoughtRaw;
                    } else if (pendingThoughtSoFar.startsWith(thoughtRaw)) {
                      // ignore
                    } else {
                      pendingThoughtSoFar += thoughtRaw;
                    }
                  }
                  continue;
                }

                // Standalone thought (2025 API: thought comes in separate part)
                if (typeof (p as any).thought === "string") {
                  const thoughtRaw = (p as any).thought;
                  if (thoughtRaw) {
                    if (thoughtRaw.startsWith(pendingThoughtSoFar)) {
                      pendingThoughtSoFar = thoughtRaw;
                    } else if (pendingThoughtSoFar.startsWith(thoughtRaw)) {
                      // ignore
                    } else {
                      pendingThoughtSoFar += thoughtRaw;
                    }
                  }
                  continue;
                }
              }
            }
          }

          // If the upstream didn't actually stream SSE, try parsing the whole body as JSON.
          if (!sawDataLine && raw.trim()) {
            try {
              const obj = JSON.parse(raw);
              const extracted0 = geminiExtractTextAndToolCalls(obj);
              if (debug) {
                logDebug(debug, reqId, "gemini stream fallback non-sse", {
                  label,
                  rawPreview: previewString(raw, 1200),
                  extractedTextLen: typeof extracted0.text === "string" ? extracted0.text.length : 0,
                  extractedReasoningLen: typeof extracted0.reasoning === "string" ? extracted0.reasoning.length : 0,
                  extractedToolCalls: Array.isArray(extracted0.toolCalls) ? extracted0.toolCalls.length : 0,
                });
              }
              return extracted0;
            } catch {
              // ignore
            }
          }

          const toolCalls = Array.from(toolCallKeyToMeta.values()).map((m) => {
            const tc: any = {
              id: m.id,
              type: "function",
              function: { name: m.name || "", arguments: typeof m.args === "string" && m.args.trim() ? m.args : "{}" },
            };
            if (typeof m.thought_signature === "string" && m.thought_signature.trim()) tc.thought_signature = m.thought_signature.trim();
            if (typeof m.thought === "string") tc.thought = m.thought;
            return tc;
          });

          const combinedReasoning = [thoughtSummarySoFar, pendingThoughtSoFar].map((v) => String(v || "").trim()).filter(Boolean).join("\n\n");
          const extracted = {
            text: textSoFar,
            reasoning: combinedReasoning,
            toolCalls,
            finish_reason: geminiFinishReasonToOpenai(lastFinishReason, toolCalls.length > 0),
            usage: geminiUsageToOpenaiUsage(usageMetadata),
          };

          if (debug) {
            if (bytesIn0 === 0) {
              logDebug(debug, reqId, "gemini stream fallback empty body", {
                label,
                status: resp2.status,
                contentType: resp2.headers.get("content-type") || "",
                contentLength: resp2.headers.get("content-length") || "",
              });
            }
            logDebug(debug, reqId, "gemini stream fallback parsed", {
              label,
              bytesIn: bytesIn0,
              sseDataLines: sseDataLines0,
              textLen: typeof extracted.text === "string" ? extracted.text.length : 0,
              reasoningLen: typeof extracted.reasoning === "string" ? extracted.reasoning.length : 0,
              toolCalls: toolCalls.length,
              finish_reason: extracted.finish_reason,
            });
          }

          return extracted;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? "stream fallback failed");
          if (debug) logDebug(debug, reqId, "gemini stream fallback error", { label, error: message });
          return null;
        }
      };

      const extracted2 = await tryStreamFallback("streamGenerateContent", geminiBody);
      if (extracted2 && !shouldRetryEmpty(extracted2)) {
        extracted = extracted2;
      } else if (debug) {
        logDebug(debug, reqId, "gemini stream fallback empty", {
          textLen: typeof extracted2?.text === "string" ? extracted2.text.length : 0,
          reasoningLen: typeof extracted2?.reasoning === "string" ? extracted2.reasoning.length : 0,
          toolCalls: Array.isArray(extracted2?.toolCalls) ? extracted2.toolCalls.length : 0,
        });
      }
    }

    const { text, reasoning, toolCalls, finish_reason, usage } = extracted;
    if (debug) {
      logDebug(debug, reqId, "gemini parsed", {
        finish_reason,
        textLen: typeof text === "string" ? text.length : 0,
        textPreview: typeof text === "string" ? previewString(text, 800) : "",
        reasoningLen: typeof reasoning === "string" ? reasoning.length : 0,
        reasoningPreview: typeof reasoning === "string" ? previewString(reasoning, 600) : "",
        toolCalls: toolCalls.map((c) => ({
          name: c.function?.name || "",
          id: c.id || "",
          argsLen: c.function?.arguments?.length || 0,
          hasThoughtSig: !!c.thought_signature,
        })),
        usage: usage || null,
        candidatesCount: Array.isArray(gjson?.candidates) ? gjson.candidates.length : 0,
        hasPromptFeedback: !!gjson?.promptFeedback,
      });
      if (shouldRetryEmpty(extracted)) {
        const cand0 = Array.isArray((gjson as any)?.candidates) ? (gjson as any).candidates[0] : null;
        const candPreview = cand0 ? previewString(safeJsonStringifyForLog(cand0), 1600) : "";
        const rootPreview = previewString(safeJsonStringifyForLog(gjson), 2000);
        logDebug(debug, reqId, "gemini upstream empty response", {
          candidatesCount: Array.isArray((gjson as any)?.candidates) ? (gjson as any).candidates.length : 0,
          candidate0Keys: cand0 && typeof cand0 === "object" ? Object.keys(cand0) : [],
          candidate0Preview: candPreview,
          rootPreview,
        });
      }
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
          message: {
            role: "assistant",
            content: toolCallsOut.length ? null : text || "",
            ...(reasoning && reasoning.trim() ? { reasoning_content: reasoning } : {}),
            ...(toolCallsOut.length ? { tool_calls: toolCallsOut } : {}),
          },
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
  let overrideFinishReason: string | null = null;
  let sawAnyReasoning = false;
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

    const emitReasoningDelta = async (deltaText) => {
      if (typeof deltaText !== "string" || !deltaText) return;
      await ensureAssistantRoleSent();
      sawAnyReasoning = true;
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: outModel,
        choices: [{ index: 0, delta: { reasoning_content: deltaText }, finish_reason: null }],
      };
      await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
    };

    const emitToolCallDelta = async (meta, argsDelta) => {
      if (!meta || typeof meta !== "object") return;
      await ensureAssistantRoleSent();
      const fn: any = {};
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
        const meta: any = {
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
      let pendingThoughtSummarySoFar = "";
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
            .map((p) => {
              if (!p || typeof p !== "object") return "";
              // Thought summary text comes through as `text` with `thought: true`.
              if (p.thought === true) return "";
              return typeof p.text === "string" ? p.text : "";
            })
            .filter(Boolean)
            .join("");

          for (const p of parts) {
            if (!p || typeof p !== "object") continue;

            // Thought summary text comes through as `text` with `thought: true`
            if (p.thought === true && typeof p.text === "string") {
              const thoughtSummaryText = p.text;
              if (thoughtSummaryText) {
                let delta = "";
                if (thoughtSummaryText.startsWith(pendingThoughtSummarySoFar)) {
                  delta = thoughtSummaryText.slice(pendingThoughtSummarySoFar.length);
                  pendingThoughtSummarySoFar = thoughtSummaryText;
                } else if (pendingThoughtSummarySoFar.startsWith(thoughtSummaryText)) {
                  delta = "";
                } else {
                  delta = thoughtSummaryText;
                  pendingThoughtSummarySoFar += thoughtSummaryText;
                }
                if (delta) await emitReasoningDelta(delta);
              }

              const thoughtSigRaw = p.thoughtSignature || p.thought_signature || "";
              if (typeof thoughtSigRaw === "string" && thoughtSigRaw.trim()) {
                pendingThoughtSignature = thoughtSigRaw.trim();
              }
              continue;
            }

            const fc = p.functionCall;
            if (fc && typeof fc === "object") {
              // Extract thought_signature from the same part (2025 API: thoughtSignature is sibling to functionCall)
              const thoughtSig = p.thoughtSignature || p.thought_signature || fc.thoughtSignature || fc.thought_signature || pendingThoughtSignature || "";
              const thought = p.thought || fc.thought || pendingThought || "";

              const directThought = p.thought || fc.thought;
              if (typeof directThought === "string" && directThought) {
                await emitReasoningDelta(directThought);
              }

              await upsertToolCall(fc.name, fc.args, thoughtSig, thought);
              // Reset pending after consuming
              pendingThought = "";
              pendingThoughtSummarySoFar = "";
              pendingThoughtSignature = "";
              continue;
            }

            // Handle standalone thought parts (if they come separately)
            if (
              typeof p.thought === "string" ||
              typeof p.thought_signature === "string" ||
              typeof p.thoughtSignature === "string"
            ) {
              if (typeof p.thought === "string") {
                pendingThought = p.thought;
                if (p.thought) await emitReasoningDelta(p.thought);
              }
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
            if (delta) {
              await emitTextDelta(delta);
              pendingThought = "";
              pendingThoughtSummarySoFar = "";
              pendingThoughtSignature = "";
            }
          }
        }
      }
      try {
        await reader.cancel();
      } catch { }
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
            for (const tc of extracted.toolCalls) {
              await upsertToolCall(tc.function?.name, safeJsonParse(tc.function?.arguments || "{}").value, undefined, undefined);
            }
          }
          if (typeof extracted.reasoning === "string" && extracted.reasoning.trim()) await emitReasoningDelta(extracted.reasoning);
          if (extracted.text) {
            await emitTextDelta(extracted.text);
            textSoFar = extracted.text;
          }
          if (typeof extracted.finish_reason === "string" && extracted.finish_reason) {
            lastFinishReason = extracted.finish_reason;
            overrideFinishReason = extracted.finish_reason;
          }
        } catch {
          // ignore
        }
      }

      // Some Gemini gateways return an "empty" SSE stream when maxOutputTokens is too large.
      // If we saw no output at all, retry with smaller caps (and keep thought summaries enabled when possible).
      const sawAnyMeaningful = Boolean(textSoFar) || toolCallKeyToMeta.size > 0 || sawAnyReasoning;
      if (!sawAnyMeaningful) {
        const nonStreamUrl = buildGeminiGenerateContentUrl(geminiBase, geminiModelId, false);
        const nonStreamHeaders = { ...geminiHeaders, Accept: "application/json" };

        const isExtractedEmpty = (extracted) => {
          if (!extracted || typeof extracted !== "object") return true;
          const text0 = typeof extracted.text === "string" ? extracted.text.trim() : "";
          const toolCalls0 = Array.isArray(extracted.toolCalls) ? extracted.toolCalls : [];
          const reasoning0 = typeof extracted.reasoning === "string" ? extracted.reasoning.trim() : "";
          return !text0 && toolCalls0.length === 0 && !reasoning0;
        };

        const cloneBody = (body) => {
          try {
            return JSON.parse(JSON.stringify(body));
          } catch {
            return null;
          }
        };

        const tryVariant = async (label, bodyOverride) => {
          if (!nonStreamUrl || !bodyOverride || typeof bodyOverride !== "object") return null;
          try {
            const resp2 = await fetch(nonStreamUrl, { method: "POST", headers: nonStreamHeaders, body: JSON.stringify(bodyOverride) });
            if (!resp2.ok) return null;
            const gjson2 = await resp2.json().catch(() => null);
            if (!gjson2 || typeof gjson2 !== "object") return null;
            const extracted2 = geminiExtractTextAndToolCalls(gjson2);
            if (debug) {
              logDebug(debug, reqId, "gemini stream empty retry", {
                label,
                retryMaxOutputTokens: bodyOverride?.generationConfig?.maxOutputTokens ?? null,
                retryIncludeThoughts: bodyOverride?.generationConfig?.thinkingConfig?.includeThoughts ?? null,
                textLen: typeof extracted2?.text === "string" ? extracted2.text.length : 0,
                reasoningLen: typeof extracted2?.reasoning === "string" ? extracted2.reasoning.length : 0,
                toolCalls: Array.isArray(extracted2?.toolCalls) ? extracted2.toolCalls.length : 0,
                candidatesCount: Array.isArray((gjson2 as any)?.candidates) ? (gjson2 as any).candidates.length : 0,
                hasPromptFeedback: !!(gjson2 as any)?.promptFeedback,
              });
            }
            return { gjson: gjson2, extracted: extracted2 };
          } catch {
            return null;
          }
        };

        const retryMaxValues = [8192, 4096, 2048];
        let fallback: any = null;

        for (const maxOut of retryMaxValues) {
          const b1 = cloneBody(geminiBody);
          if (!b1) continue;
          if (!b1.generationConfig || typeof b1.generationConfig !== "object") b1.generationConfig = {};
          b1.generationConfig.maxOutputTokens = maxOut;
          if (!b1.generationConfig.thinkingConfig || typeof b1.generationConfig.thinkingConfig !== "object") {
            b1.generationConfig.thinkingConfig = { includeThoughts: true };
          } else if (!("includeThoughts" in b1.generationConfig.thinkingConfig)) {
            b1.generationConfig.thinkingConfig.includeThoughts = true;
          }
          const res = await tryVariant(`maxOutputTokens=${maxOut}`, b1);
          if (res && !isExtractedEmpty(res.extracted)) {
            fallback = res;
            break;
          }
        }

        // Last resort: disable thought summaries and retry with smaller caps.
        if (!fallback) {
          for (const maxOut of retryMaxValues) {
            const b2 = cloneBody(geminiBody);
            if (!b2) continue;
            if (!b2.generationConfig || typeof b2.generationConfig !== "object") b2.generationConfig = {};
            b2.generationConfig.maxOutputTokens = maxOut;
            if (b2.generationConfig && typeof b2.generationConfig === "object") {
              delete b2.generationConfig.thinkingConfig;
            }
            const res = await tryVariant(`disableThinkingConfig maxOutputTokens=${maxOut}`, b2);
            if (res && !isExtractedEmpty(res.extracted)) {
              fallback = res;
              break;
            }
          }
        }

        if (fallback && fallback.extracted) {
          const ex = fallback.extracted;
          if (typeof ex.reasoning === "string" && ex.reasoning.trim()) {
            await emitReasoningDelta(ex.reasoning);
          }
          if (Array.isArray(ex.toolCalls)) {
            for (const tc of ex.toolCalls) {
              const name = tc?.function?.name;
              const args = tc?.function?.arguments;
              await upsertToolCall(name, args, tc?.thought_signature, tc?.thought);
            }
          }
          if (typeof ex.text === "string" && ex.text) {
            await emitTextDelta(ex.text);
            textSoFar = ex.text;
          }
          if (typeof ex.finish_reason === "string" && ex.finish_reason) {
            lastFinishReason = ex.finish_reason;
            overrideFinishReason = ex.finish_reason;
          }
        }
      }

      if (debug) {
        logDebug(debug, reqId, "gemini stream summary", {
          bytesIn,
          sseDataLines,
          toolCalls: Array.from(toolCallKeyToMeta.values()).map((m) => ({
            name: m.name || "",
            id: m.id || "",
            argsLen: m.args?.length || 0,
            hasThoughtSig: !!m.thought_signature,
          })),
          finish_reason: overrideFinishReason || geminiFinishReasonToOpenai(lastFinishReason, toolCallKeyToMeta.size > 0),
          textLen: textSoFar.length,
        });
      }

      if (!sentFinal) {
        try {
          const finishReason = overrideFinishReason || geminiFinishReasonToOpenai(lastFinishReason, toolCallKeyToMeta.size > 0);
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
      } catch { }
      try {
        await writer.close();
      } catch { }
    }
  })();

  return new Response(readable, { status: 200, headers: sseHeaders() });
}

function splitCommaSeparatedUrls(raw) {
  const text = typeof raw === "string" ? raw : "";
  return text
    .split(",")
    .map((v) => normalizeBaseUrl(v))
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeGeminiModelIdForUpstream(modelId) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return "";

  // Preserve explicit Gemini API paths.
  if (raw.startsWith("models/") || raw.startsWith("tunedModels/")) return raw;

  // Strip provider namespaces like "google/gemini-3-flash-preview".
  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

export async function handleGeminiGenerateContentUpstream({
  request,
  env,
  reqJson,
  model,
  stream,
  debug,
  reqId,
}: {
  request?: Request;
  env: any;
  reqJson: any;
  model: string;
  stream: boolean;
  debug: boolean;
  reqId: string;
}): Promise<Response> {
  const geminiBases = splitCommaSeparatedUrls(env?.GEMINI_BASE_URL);
  if (!geminiBases.length) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_BASE_URL", "server_error"));

  const geminiKey = normalizeAuthValue(env?.GEMINI_API_KEY);
  if (!geminiKey) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_API_KEY", "server_error"));

  const upstreamModelId = normalizeGeminiModelIdForUpstream(model);
  if (!upstreamModelId) return jsonResponse(400, jsonError("Missing required field: model", "invalid_request_error"));

  const body = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  for (const k of Object.keys(body)) {
    if (k.startsWith("__")) delete body[k];
  }

  // Strip common gateway hints when present.
  delete (body as any).model;
  delete (body as any).stream;
  delete (body as any).provider;
  delete (body as any).owned_by;
  delete (body as any).ownedBy;

  // Validate that contents are non-empty and usable (Gemini requires at least one user turn).
  const normContents = normalizeGeminiContents((body as any).contents, { requireUser: true });
  if (!normContents.ok) return jsonResponse(400, jsonError(normContents.error, "invalid_request_error"));
  (body as any).contents = normContents.contents;

  const headers = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "rsp4copilot",
    "x-goog-api-key": geminiKey,
  };
  const xSessionId = request?.headers?.get?.("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) headers["x-session-id"] = xSessionId.trim();

  let lastResp: Response | null = null;
  let lastErr: string | null = null;

  for (const base of geminiBases) {
    const geminiUrl = buildGeminiGenerateContentUrl(base, upstreamModelId, stream);
    if (!geminiUrl) continue;

    try {
      const resp = await fetch(geminiUrl, { method: "POST", headers, body: JSON.stringify(body) });
      if (resp.ok) {
        if (stream) return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } });
      }

      const errText = await resp.text().catch(() => "");
      lastResp = resp;
      lastErr = errText;
      const retryable = resp.status >= 500;
      if (debug) {
        logDebug(debug, reqId, "gemini upstream error", {
          upstreamUrl: geminiUrl,
          status: resp.status,
          retryable,
          errorPreview: previewString(errText, 1200),
        });
      }
      if (!retryable) {
        return new Response(errText, { status: resp.status, headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
      lastErr = message;
      if (debug) logDebug(debug, reqId, "gemini upstream fetch failed", { upstreamUrl: geminiUrl, error: message });
      continue;
    }
  }

  if (lastResp) {
    return new Response(lastErr || "", {
      status: lastResp.status || 502,
      headers: { "content-type": lastResp.headers.get("content-type") || "application/json; charset=utf-8" },
    });
  }

  return jsonResponse(502, jsonError(`Gemini upstream error: ${lastErr || "no upstream available"}`, "bad_gateway"));
}
