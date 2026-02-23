import {
  appendInstructions,
  applyTemperatureTopPFromRequest,
  getSessionKey,
  jsonError,
  jsonResponse,
  logDebug,
  maskSecret,
  measureOpenAIChatMessages,
  previewString,
  safeJsonStringifyForLog,
  trimOpenAIChatMessages,
} from "../../common";
import {
  collectThoughtSignatureUpdatesFromResponsesSsePayload,
  extractFromResponsesSseText,
  extractOutputTextFromResponsesResponse,
  extractThoughtSignatureUpdatesFromResponsesResponse,
  extractToolCallsFromResponsesResponse,
} from "./responses_extract";
import { chatMessagesToResponsesInput, openaiToolChoiceToResponsesToolChoice, openaiToolsToResponsesTools } from "./responses_input";
import { responsesReqVariants } from "./responses_variants";
import { getSessionPreviousResponseId, setSessionPreviousResponseId } from "./session_cache";
import { applyCachedThoughtSignaturesToResponsesRequest, getResponsesThoughtSignatureCache, setResponsesThoughtSignatureCache } from "./thought_signature_cache";
import { selectUpstreamResponseAny } from "./upstream_select";
import { handleOpenAIChatCompletionsViaResponsesStream } from "./handle_chat_completions_stream";
import { SseTextStreamParser } from "../../protocols/stream/sse";

type PromptCacheParams = { prompt_cache_retention: string; safety_identifier: string };

function applyCommonResponsesRequestFields(
  reqJson: any,
  out: any,
  opts: {
    reasoningEffort: string;
    promptCache: PromptCacheParams;
    instructions: string;
    maxTokens: number | null;
    tools: any[];
    toolChoice: any;
  },
): void {
  if (opts.reasoningEffort) out.reasoning = { effort: opts.reasoningEffort };
  if (opts.promptCache.prompt_cache_retention) out.prompt_cache_retention = opts.promptCache.prompt_cache_retention;
  if (opts.promptCache.safety_identifier) out.safety_identifier = opts.promptCache.safety_identifier;
  if (opts.instructions) out.instructions = opts.instructions;
  applyTemperatureTopPFromRequest(reqJson, out);
  if ("stop" in reqJson) out.stop = reqJson.stop;
  if (Array.isArray(opts.tools) && opts.tools.length) out.tools = opts.tools;
  if (opts.toolChoice !== undefined) out.tool_choice = opts.toolChoice;
  if (Number.isInteger(opts.maxTokens)) out.max_output_tokens = opts.maxTokens;
}

function hasAssistantMessage(messages: any): boolean {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && typeof m === "object" && (m as any).role === "assistant") return true;
  }
  return false;
}

function indexOfLastAssistantMessage(messages: any): number {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && typeof m === "object" && (m as any).role === "assistant") return i;
  }
  return -1;
}

export async function handleOpenAIChatCompletionsViaResponses({
  request,
  upstreamUrls,
  headers,
  upstreamStream,
  reqJson,
  model,
  stream,
  token,
  limits,
  maxBufferedSseBytes,
  reasoningEffort,
  promptCache,
  debug,
  reqId,
  path,
  startedAt,
  extraSystemText,
}: {
  request: Request;
  upstreamUrls: string[];
  headers: Record<string, string>;
  upstreamStream: boolean;
  reqJson: any;
  model: string;
  stream: boolean;
  token: string;
  limits: { maxTurns: number; maxMessages: number; maxInputChars: number };
  maxBufferedSseBytes: number;
  reasoningEffort: string;
  promptCache: { prompt_cache_retention: string; safety_identifier: string };
  debug: boolean;
  reqId: string;
  path: string;
  startedAt: number;
  extraSystemText: string;
}): Promise<Response> {
  // /v1/chat/completions
  const messages = reqJson?.messages;
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
  const thoughtSigCache = sessionKey ? await getResponsesThoughtSignatureCache(sessionKey) : {};
  if (debug) {
    logDebug(debug, reqId, "openai session", {
      sessionKey: sessionKey ? maskSecret(sessionKey) : "",
      thoughtSigCacheEntries: sessionKey ? Object.keys(thoughtSigCache).length : 0,
      multiTurnPossible: hasAssistantMessage(messagesForUpstream),
      withinLimits,
      incoming: incomingStats,
      trimmed: trimRes.trimmed,
    });
  }

  const { instructions, input } = chatMessagesToResponsesInput(messagesForUpstream);
  if (!input.length) return jsonResponse(400, jsonError("messages must include at least one non-system message"));

  const effectiveInstructions = appendInstructions(instructions, extraSystemText);
  const respTools = openaiToolsToResponsesTools(reqJson.tools);
  const respToolChoice = openaiToolChoiceToResponsesToolChoice(reqJson.tool_choice);

  const fullReq: any = {
    model,
    input,
  };
  const maxTokens = Number.isInteger(reqJson.max_tokens)
    ? reqJson.max_tokens
    : Number.isInteger(reqJson.max_completion_tokens)
      ? reqJson.max_completion_tokens
      : null;
  applyCommonResponsesRequestFields(reqJson, fullReq, {
    reasoningEffort,
    promptCache,
    instructions: effectiveInstructions,
    maxTokens,
    tools: respTools,
    toolChoice: respToolChoice,
  });

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
    applyCommonResponsesRequestFields(reqJson, prevReq, {
      reasoningEffort,
      promptCache,
      instructions: effectiveInstructions,
      maxTokens,
      tools: respTools,
      toolChoice: respToolChoice,
    });
  }

  const patchedFull = applyCachedThoughtSignaturesToResponsesRequest(fullReq, thoughtSigCache);
  const patchedPrev = prevReq ? applyCachedThoughtSignaturesToResponsesRequest(prevReq, thoughtSigCache) : { filled: 0, dropped: 0, missing: 0 };
  if (debug && (patchedFull.filled || patchedFull.dropped || patchedFull.missing || patchedPrev.filled || patchedPrev.dropped || patchedPrev.missing)) {
    logDebug(debug, reqId, "openai chat thought_signature patch", {
      full: patchedFull,
      prev: patchedPrev,
    });
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
    let responseId: string | null = null;
    let sawDelta = false;
    let sawAnyText = false;
    let sawToolCall = false;
    let sawDataLine = false;
    let raw = "";
    let bufferedBytes = 0;
    const maxBytes = Number.isFinite(maxBufferedSseBytes) ? maxBufferedSseBytes : 0;
    const thoughtSigUpdates: any = {};
    const toolCallsById = new Map<string, { name: string; args: string }>(); // call_id -> { name, args }
    const upsertToolCall = (callIdRaw: any, nameRaw: any, argsRaw: any, mode: "delta" | "full") => {
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
    const reader = sel.resp.body!.getReader();
    const decoder = new TextDecoder();
    const sse = new SseTextStreamParser();
    let finished = false;
    let overflow = false;
    const handleEventData = (data: string): boolean => {
      if (!data) return false;
      sawDataLine = true;
      if (data === "[DONE]") return true;

      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        return false;
      }

      collectThoughtSignatureUpdatesFromResponsesSsePayload(payload, thoughtSigUpdates);
      const evt = payload?.type;
      if (evt === "response.created" && payload?.response && typeof payload.response === "object") {
        const rid = payload.response.id;
        if (typeof rid === "string" && rid) responseId = rid;
        return false;
      }
      if (evt === "response.function_call_arguments.delta") {
        upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.delta, "delta");
        return false;
      }
      if (evt === "response.function_call_arguments.done" || evt === "response.function_call.done") {
        upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.arguments, "full");
        return false;
      }
      if ((evt === "response.output_item.added" || evt === "response.output_item.done") && payload?.item && typeof payload.item === "object") {
        const item = payload.item;
        if (item?.type === "function_call") {
          upsertToolCall(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments, "full");
        }
        return false;
      }
      if ((evt === "response.reasoning.delta" || evt === "response.reasoning_summary.delta") && typeof payload.delta === "string") {
        reasoningText += payload.delta;
        return false;
      }
      if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string") {
        sawDelta = true;
        sawAnyText = true;
        fullText += payload.delta;
        return false;
      }
      if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string") {
        sawAnyText = true;
        fullText += payload.text;
        return false;
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
        return true;
      }
      if (evt === "response.failed") {
        return true;
      }

      return false;
    };
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      bufferedBytes += value.byteLength;
      if (maxBytes > 0 && bufferedBytes > maxBytes) {
        overflow = true;
        break;
      }
      const chunkText = decoder.decode(value, { stream: true });
      const events = sse.push(chunkText);
      for (const evt0 of events) {
        if (handleEventData(evt0.data)) {
          finished = true;
          break;
        }
      }
      if (!sawDataLine) raw += chunkText;
    }
    if (!finished) {
      for (const evt0 of sse.finish()) {
        if (handleEventData(evt0.data)) {
          finished = true;
          break;
        }
      }
    }
    try {
      await reader.cancel();
    } catch {}
    if (overflow) {
      if (debug) {
        logDebug(debug, reqId, "openai upstream buffered sse overflow", {
          maxBytes,
          bufferedBytes,
          sawDataLine,
          sawDelta,
          sawAnyText,
          textLen: fullText.length,
          reasoningLen: reasoningText.length,
        });
      }
      return jsonResponse(
        502,
        jsonError(
          `Upstream event-stream output exceeded RESP_MAX_BUFFERED_SSE_BYTES (${maxBytes}); please use stream:true to avoid buffering`,
          "bad_gateway",
        ),
      );
    }
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
          Object.assign(thoughtSigUpdates, extractThoughtSignatureUpdatesFromResponsesResponse(responseObj));
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
    if (sessionKey) await setResponsesThoughtSignatureCache(sessionKey, thoughtSigUpdates);
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
        maxBufferedSseBytes: maxBytes,
        bufferedBytes,
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

  return handleOpenAIChatCompletionsViaResponsesStream({
    upstreamResp: sel.resp,
    model,
    sessionKey,
    debug,
    reqId,
    startedAt,
  });
}
