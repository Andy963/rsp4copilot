import {
  getRsp4CopilotLimits,
  getRsp4CopilotStreamLimits,
  getSessionKey,
  jsonError,
  jsonResponse,
  logDebug,
  maskSecret,
  normalizeAuthValue,
  previewString,
  redactHeadersForLog,
  safeJsonStringifyForLog,
  sseHeaders,
} from "../../common";
import { getReasoningEffort } from "./params";
import {
  collectThoughtSignatureUpdatesFromResponsesSsePayload,
  extractThoughtSignatureUpdatesFromResponsesResponse,
} from "./responses_extract";
import { responsesReqVariants } from "./responses_variants";
import { selectUpstreamResponseAny } from "./upstream_select";
import {
  applyCachedThoughtSignaturesToResponsesRequest,
  getResponsesThoughtSignatureCache,
  setResponsesThoughtSignatureCache,
} from "./thought_signature_cache";
import { sanitizeResponsesToolItemsForUpstream, trimOpenAIResponsesRequestToMaxChars } from "./trim";
import { buildUpstreamUrls } from "./urls";

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

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: upstreamStream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${upstreamKey}`,
    "x-api-key": upstreamKey,
    "x-goog-api-key": upstreamKey,
    "openai-beta": "responses=v1",
  };
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) headers["x-session-id"] = xSessionId.trim();
  if (debug) logDebug(debug, reqId, "openai upstream headers", { headers: redactHeadersForLog(headers) });

  const bodyBase = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  bodyBase.model = upstreamModel;
  bodyBase.stream = upstreamStream;
  for (const k of Object.keys(bodyBase)) {
    if (k.startsWith("__")) delete bodyBase[k];
  }

  const sanitizeRes = sanitizeResponsesToolItemsForUpstream(bodyBase);
  if (debug && (sanitizeRes.normalizedCallIds || sanitizeRes.droppedToolOutputs)) {
    logDebug(debug, reqId, "openai responses sanitize tool items", {
      normalizedCallIds: sanitizeRes.normalizedCallIds,
      droppedToolOutputs: sanitizeRes.droppedToolOutputs,
      hasPreviousResponseId: Boolean(bodyBase.previous_response_id),
      inputItems: Array.isArray(bodyBase.input) ? bodyBase.input.length : 0,
    });
  }

  const sessionKey = getSessionKey(request, bodyBase, token);
  const thoughtSigCache = sessionKey ? await getResponsesThoughtSignatureCache(sessionKey) : {};
  const patchRes = applyCachedThoughtSignaturesToResponsesRequest(bodyBase, thoughtSigCache);
  if (debug && (patchRes.filled || patchRes.dropped || patchRes.missing)) {
    logDebug(debug, reqId, "openai responses thought_signature patch", {
      sessionKey: sessionKey ? maskSecret(sessionKey) : "",
      thoughtSigCacheEntries: sessionKey ? Object.keys(thoughtSigCache).length : 0,
      ...patchRes,
    });
  }

  const reasoningEffort = getReasoningEffort(bodyBase, env);
  if (reasoningEffort) {
    const r0 = bodyBase.reasoning;
    if (r0 && typeof r0 === "object" && !Array.isArray(r0)) bodyBase.reasoning = { ...r0, effort: reasoningEffort };
    else bodyBase.reasoning = { effort: reasoningEffort };
  }

  const maxInputChars = limits.maxInputChars;
  if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
    const trimRes = trimOpenAIResponsesRequestToMaxChars(bodyBase, maxInputChars);
    if (debug && (trimRes as any).trimmed) {
      logDebug(debug, reqId, "openai responses trimmed", {
        beforeLen: (trimRes as any).beforeLen,
        afterLen: (trimRes as any).afterLen,
        droppedTurns: (trimRes as any).droppedTurns,
        droppedSystem: (trimRes as any).droppedSystem,
        droppedTail: (trimRes as any).droppedTail,
        truncatedInputChars: (trimRes as any).truncatedInputChars,
        truncatedInstructionChars: (trimRes as any).truncatedInstructionChars,
        droppedTools: (trimRes as any).droppedTools,
        droppedUnpairedToolCalls: (trimRes as any).droppedUnpairedToolCalls,
      });
    }
  }

  void path;
  void startedAt;

  const variants0 = responsesReqVariants(bodyBase, upstreamStream);
  const variants: any[] = [];
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

  const streamLimits = getRsp4CopilotStreamLimits(env);
  const sel = await selectUpstreamResponseAny(upstreamUrls, headers, variants, debug, reqId, {
    emptySseDetectTimeoutMs: streamLimits.emptySseDetectTimeoutMs,
  });
  if (!sel.ok && debug) {
    logDebug(debug, reqId, "openai upstream failed", { path, upstreamUrl: sel.upstreamUrl, status: sel.status, error: sel.error });
  }
  if (!sel.ok) return jsonResponse(sel.status, sel.error);

  const resp = sel.resp;
  if (stream) {
    // Pass through SSE, but also cache thought_signature for tool calls (required by some gateways).
    if (!resp.body || !sessionKey) return new Response(resp.body, { status: resp.status, headers: sseHeaders() });

    const src = resp.body;
    const decoder = new TextDecoder();
    let buf0 = "";
    const thoughtSigUpdates: any = {};

    const tapped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = src.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);

            const chunkText = decoder.decode(value, { stream: true });
            buf0 += chunkText;
            const lines = buf0.split("\n");
            buf0 = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let payload: any;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }
              collectThoughtSignatureUpdatesFromResponsesSsePayload(payload, thoughtSigUpdates);
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }

        // Best-effort parse of any remaining buffered line.
        try {
          const tail = buf0;
          buf0 = "";
          for (const line of String(tail || "").split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let payload: any;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            collectThoughtSignatureUpdatesFromResponsesSsePayload(payload, thoughtSigUpdates);
          }
        } catch {}

        try {
          await setResponsesThoughtSignatureCache(sessionKey, thoughtSigUpdates);
        } catch {}
        controller.close();
      },
    });

    return new Response(tapped, { status: resp.status, headers: sseHeaders() });
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

  if (sessionKey) {
    const updates = extractThoughtSignatureUpdatesFromResponsesResponse(responseObj);
    if (Object.keys(updates).length) await setResponsesThoughtSignatureCache(sessionKey, updates);
  }

  if (typeof outModel === "string" && outModel.trim()) responseObj.model = outModel.trim();

  return jsonResponse(200, responseObj);
}
