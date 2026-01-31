import { encodeSseData, logDebug, previewString, sseHeaders } from "../../common";
import { buildGeminiGenerateContentUrl } from "./urls";
import { geminiArgsToJsonString, geminiExtractTextAndToolCalls, geminiFinishReasonToOpenai } from "./extract";
import { setThoughtSignatureCache } from "./thought_signature_cache";

function safeJsonParse(text: unknown): { ok: true; value: any } | { ok: false; value: null } {
  if (typeof text !== "string") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

export function handleGeminiChatCompletionsStream({
  gemResp,
  geminiBody,
  geminiHeaders,
  geminiBase,
  geminiModelId,
  model,
  sessionKey,
  debug,
  reqId,
}: {
  gemResp: Response;
  geminiBody: any;
  geminiHeaders: Record<string, string>;
  geminiBase: string;
  geminiModelId: string;
  model: string;
  sessionKey: string;
  debug: boolean;
  reqId: string;
}): Response {
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

  const toolCallKeyToMeta = new Map<string, any>(); // key -> { id, index, name, args }
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

    const emitTextDelta = async (deltaText: unknown) => {
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

    const emitReasoningDelta = async (deltaText: unknown) => {
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

    const emitToolCallDelta = async (meta: any, argsDelta: unknown) => {
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

    const upsertToolCall = async (nameRaw: any, argsRaw: any, thoughtSignature: any, thought: any) => {
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
      const reader = gemResp.body!.getReader();
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
          let payload: any;
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
            .map((p: any) => {
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

        const isExtractedEmpty = (extracted: any) => {
          if (!extracted || typeof extracted !== "object") return true;
          const text0 = typeof extracted.text === "string" ? extracted.text.trim() : "";
          const toolCalls0 = Array.isArray(extracted.toolCalls) ? extracted.toolCalls : [];
          const reasoning0 = typeof extracted.reasoning === "string" ? extracted.reasoning.trim() : "";
          return !text0 && toolCalls0.length === 0 && !reasoning0;
        };

        const cloneBody = (body: any) => {
          try {
            return JSON.parse(JSON.stringify(body));
          } catch {
            return null;
          }
        };

        const tryVariant = async (label: string, bodyOverride: any) => {
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
          toolCalls: Array.from(toolCallKeyToMeta.values()).map((m: any) => ({
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
      } catch {}
      try {
        await writer.close();
      } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers: sseHeaders() });
}
