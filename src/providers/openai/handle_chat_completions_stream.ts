import { encodeSseData, logDebug, maskSecret, previewString, sseHeaders } from "../../common";
import {
  collectThoughtSignatureUpdatesFromResponsesSsePayload,
  extractFromResponsesSseText,
  extractOutputTextFromResponsesResponse,
  extractThoughtSignatureUpdatesFromResponsesResponse,
  extractToolCallsFromResponsesResponse,
} from "./responses_extract";
import { setSessionPreviousResponseId } from "./session_cache";
import { setResponsesThoughtSignatureCache } from "./thought_signature_cache";
import { SseTextStreamParser } from "../../protocols/stream/sse";

export function handleOpenAIChatCompletionsViaResponsesStream({
  upstreamResp,
  model,
  sessionKey,
  debug,
  reqId,
  startedAt,
}: {
  upstreamResp: Response;
  model: string;
  sessionKey: string;
  debug: boolean;
  reqId: string;
  startedAt: number;
}): Response {
  // stream=true
  let chatId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let created = Math.floor(Date.now() / 1000);
  let outModel = model;
  let responseId: string | null = null;
  let sawDelta = false;
  let sentAnyText = false;
  let sawToolCall = false;
  let sawDataLine = false;
  let raw = "";
  let sentRole = false;
  let sentFinal = false;
  const toolCallIdToIndex = new Map<string, number>(); // call_id -> index
  let nextToolCallIndex = 0;
  const toolCallsById = new Map<string, { name: string; args: string }>(); // call_id -> { name, args }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const streamStartedAt = Date.now();
    const thoughtSigUpdates: any = {};
    const getToolCallIndex = (callId: unknown) => {
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

    const emitToolCallDelta = async (callId: unknown, name: unknown, argsDelta: unknown) => {
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

    const emitReasoningDelta = async (deltaText: unknown) => {
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

    const upsertToolCall = async (callIdRaw: unknown, nameRaw: unknown, argsRaw: unknown, mode: "delta" | "full") => {
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
	      const reader = upstreamResp.body!.getReader();
	      const decoder = new TextDecoder();
	      const sse = new SseTextStreamParser();
	      let finished = false;
	      const sendFinalChunkOnce = async () => {
	        if (sentFinal) return;
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
	      };

	      const handleEventData = async (data: string): Promise<boolean> => {
	        if (!data) return false;
	        sawDataLine = true;
	        if (data === "[DONE]") {
	          await sendFinalChunkOnce();
	          return true;
	        }

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
	          if (typeof rid === "string" && rid) {
	            responseId = rid;
	            chatId = `chatcmpl_${rid}`;
	          }
	          const m = payload.response.model;
	          if (typeof m === "string" && m) outModel = m;
	          const c = payload.response.created_at;
	          if (Number.isInteger(c)) created = c;
	          return false;
	        }

	        if (evt === "response.function_call_arguments.delta") {
	          await upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.delta, "delta");
	          return false;
	        }

	        if (evt === "response.function_call_arguments.done" || evt === "response.function_call.done") {
	          await upsertToolCall(payload.call_id ?? payload.callId ?? payload.id, payload.name, payload.arguments, "full");
	          return false;
	        }

	        if ((evt === "response.output_item.added" || evt === "response.output_item.done") && payload?.item && typeof payload.item === "object") {
	          const item = payload.item;
	          if (item?.type === "function_call") {
	            await upsertToolCall(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments, "full");
	          }
	          return false;
	        }

	        if ((evt === "response.reasoning.delta" || evt === "response.reasoning_summary.delta") && typeof payload.delta === "string" && payload.delta) {
	          await emitReasoningDelta(payload.delta);
	          return false;
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
	          return false;
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
	          return false;
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

	          await sendFinalChunkOnce();
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
	          if (await handleEventData(evt0.data)) {
	            finished = true;
	            break;
	          }
	        }
	      }
	      if (!finished) {
	        for (const evt0 of sse.finish()) {
	          if (await handleEventData(evt0.data)) {
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
            if (typeof ex.createdAt === "number" && Number.isInteger(ex.createdAt)) created = ex.createdAt;
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
            Object.assign(thoughtSigUpdates, extractThoughtSignatureUpdatesFromResponsesResponse(responseObj));
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
      if (sessionKey) await setResponsesThoughtSignatureCache(sessionKey, thoughtSigUpdates);
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
