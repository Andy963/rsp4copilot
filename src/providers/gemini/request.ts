import { appendInstructions, normalizeMessageContent, normalizeToolCallsFromChatMessage } from "../../common";
import { openaiContentToGeminiParts } from "./media";
import { openaiToolChoiceToGeminiToolConfig, openaiToolsToGeminiFunctionDeclarations } from "./tools";

function safeJsonParse(text: unknown): { ok: true; value: any } | { ok: false; value: null } {
  if (typeof text !== "string") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

export async function openaiChatToGeminiRequest(
  reqJson: any,
  env: any,
  fetchFn: typeof fetch,
  extraSystemText: string,
  thoughtSigCache: any,
): Promise<any> {
  const messages = Array.isArray(reqJson?.messages) ? reqJson.messages : [];
  const systemTextParts: string[] = [];
  const contents: any[] = [];
  const toolNameByCallId = new Map();
  // Cache for looking up thought_signature by call_id
  const sigCache = thoughtSigCache && typeof thoughtSigCache === "object" ? thoughtSigCache : {};

  const toolMessageToFunctionResponsePart = (msg: any, fallbackName = "") => {
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
      const parts: any[] = [];
      const txt = normalizeMessageContent(msg.content);
      if (txt && String(txt).trim()) parts.push({ text: String(txt) });

      const calls = normalizeToolCallsFromChatMessage(msg);
      const callOrder: any[] = [];
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
          const respParts: any[] = [];
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
      const respParts: any[] = [];
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
    else if (Array.isArray(st)) generationConfig.stopSequences = st.filter((x: any) => typeof x === "string" && x);
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

