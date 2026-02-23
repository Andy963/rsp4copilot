import {
  applyTemperatureTopPFromRequest,
  encodeSseData,
  jsonError,
  jsonResponse,
  logDebug,
  previewString,
  safeJsonStringifyForLog,
  sseHeaders,
} from "../../common";
import { SseTextStreamParser } from "../../protocols/stream/sse";
import { extractFromResponsesSseText, extractOutputTextFromResponsesResponse } from "./responses_extract";
import { responsesReqVariants } from "./responses_variants";
import { selectUpstreamResponseAny } from "./upstream_select";
import { trimOpenAIResponsesRequestToMaxChars } from "./trim";

export async function handleOpenAITextCompletionsViaResponses({
  upstreamUrls,
  headers,
  upstreamStream,
  reqJson,
  model,
  stream,
  limits,
  maxBufferedSseBytes,
  reasoningEffort,
  promptCache,
  debug,
  reqId,
  path,
}: {
  upstreamUrls: string[];
  headers: Record<string, string>;
  upstreamStream: boolean;
  reqJson: any;
  model: string;
  stream: boolean;
  limits: { maxInputChars: number };
  maxBufferedSseBytes: number;
  reasoningEffort: string;
  promptCache: { prompt_cache_retention: string; safety_identifier: string };
  debug: boolean;
  reqId: string;
  path: string;
}): Promise<Response> {
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

  const maxInputChars = limits.maxInputChars;
  if (Number.isInteger(maxInputChars) && maxInputChars > 0) {
    const trimRes = trimOpenAIResponsesRequestToMaxChars(responsesReq, maxInputChars);
    if (debug && (trimRes as any).trimmed) {
      logDebug(debug, reqId, "openai completions trimmed", {
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

  const variants0 = responsesReqVariants(responsesReq, upstreamStream);
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
    const sse = new SseTextStreamParser();
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
      const evt = payload?.type;
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
      if (!sawDelta && !sawAnyText && evt === "response.completed" && payload?.response && typeof payload.response === "object") {
        const t = extractOutputTextFromResponsesResponse(payload.response);
        if (t) {
          sawAnyText = true;
          fullText += t;
        }
        return true;
      }
      if (evt === "response.completed" || evt === "response.failed") {
        return true;
      }
      return false;
    };

    let bufferedBytes = 0;
    const maxBytes = Number.isFinite(maxBufferedSseBytes) ? maxBufferedSseBytes : 0;
    const reader = sel.resp.body!.getReader();
    const decoder = new TextDecoder();
    let finished = false;
    let overflow = false;
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        bufferedBytes += value.byteLength;
        if (maxBytes > 0 && bufferedBytes > maxBytes) {
          overflow = true;
          break;
        }
        const chunkText = decoder.decode(value, { stream: true });
        raw += chunkText;
        const events = sse.push(chunkText);
        for (const evt0 of events) {
          if (handleEventData(evt0.data)) {
            finished = true;
            break;
          }
        }
      }
      if (!finished) {
        for (const evt0 of sse.finish()) {
          if (handleEventData(evt0.data)) {
            finished = true;
            break;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
    if (overflow) {
      if (debug) logDebug(debug, reqId, "openai upstream buffered sse overflow", { maxBytes, bufferedBytes, sawDataLine, sawDelta, sawAnyText });
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
      const reader = sel.resp.body!.getReader();
      const decoder = new TextDecoder();
      const sse = new SseTextStreamParser();
      let finished = false;
      const handleEventData = async (data: string): Promise<boolean> => {
        if (!data) return false;
        sawDataLine = true;
        if (data === "[DONE]") {
          finished = true;
          return true;
        }

        let payload: any;
        try {
          payload = JSON.parse(data);
        } catch {
          return false;
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
          return false;
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
          return false;
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
          return true;
        }
        if (evt === "response.completed" || evt === "response.failed") {
          finished = true;
          return true;
        }
        return false;
      };
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        raw += chunkText;
        const events = sse.push(chunkText);
        for (const evt0 of events) {
          if (await handleEventData(evt0.data)) break;
        }
      }
      if (!finished) {
        for (const evt0 of sse.finish()) {
          if (await handleEventData(evt0.data)) break;
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
