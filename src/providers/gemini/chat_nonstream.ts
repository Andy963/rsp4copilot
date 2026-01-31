import { jsonError, jsonResponse, logDebug, previewString, safeJsonStringifyForLog } from "../../common";
import { normalizeGeminiModelId } from "./model";
import { buildGeminiGenerateContentUrl } from "./urls";
import { geminiArgsToJsonString, geminiExtractTextAndToolCalls, geminiFinishReasonToOpenai, geminiUsageToOpenaiUsage } from "./extract";
import { setThoughtSignatureCache } from "./thought_signature_cache";

export async function handleGeminiChatCompletionsNonStream({
  gemResp,
  geminiBody,
  geminiHeaders,
  geminiBase,
  model,
  geminiModelId,
  geminiUrl,
  sessionKey,
  debug,
  reqId,
}: {
  gemResp: Response;
  geminiBody: any;
  geminiHeaders: Record<string, string>;
  geminiBase: string;
  model: string;
  geminiModelId: string;
  geminiUrl: string;
  sessionKey: string;
  debug: boolean;
  reqId: string;
}): Promise<Response> {
  void normalizeGeminiModelId;

  const parseGeminiJson = async (resp: Response) => {
    let gjson: any | null = null;
    try {
      gjson = await resp.json();
    } catch {
      return { ok: false, gjson: null, extracted: null, error: "Gemini upstream returned invalid JSON" };
    }
    const extracted = geminiExtractTextAndToolCalls(gjson);
    return { ok: true, gjson, extracted, error: "" };
  };

  const shouldRetryEmpty = (extracted: any) => {
    if (!extracted || typeof extracted !== "object") return true;
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

    const cloneBody = (body: any) => {
      try {
        return JSON.parse(JSON.stringify(body));
      } catch {
        return null;
      }
    };

    const tryVariant = async (label: string, bodyOverride: any) => {
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

    const tryStreamFallback = async (label: string, bodyOverride: any) => {
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
              } catch {}
              buf = "";
              break;
            }
            let payload: any;
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
              .map((p: any) => {
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
                const name = typeof (fc as any).name === "string" ? (fc as any).name.trim() : "";
                if (!name) continue;
                const argsStr = geminiArgsToJsonString((fc as any).args);
                const key = `${name}\n${argsStr}`;

                if (!toolCallKeyToMeta.has(key)) {
                  const meta: any = {
                    id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
                    name,
                    args: "",
                  };
                  toolCallKeyToMeta.set(key, meta);
                }
                const meta: any = toolCallKeyToMeta.get(key);
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

        const toolCalls = Array.from(toolCallKeyToMeta.values()).map((m: any) => {
          const tc: any = {
            id: m.id,
            type: "function",
            function: { name: m.name || "", arguments: typeof m.args === "string" && m.args.trim() ? m.args : "{}" },
          };
          if (typeof m.thought_signature === "string" && m.thought_signature.trim()) tc.thought_signature = m.thought_signature.trim();
          if (typeof m.thought === "string") tc.thought = m.thought;
          return tc;
        });

        const combinedReasoning = [thoughtSummarySoFar, pendingThoughtSoFar]
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .join("\n\n");
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
        textLen: typeof (extracted2 as any)?.text === "string" ? (extracted2 as any).text.length : 0,
        reasoningLen: typeof (extracted2 as any)?.reasoning === "string" ? (extracted2 as any).reasoning.length : 0,
        toolCalls: Array.isArray((extracted2 as any)?.toolCalls) ? (extracted2 as any).toolCalls.length : 0,
      });
    }
  }

  if (!extracted || typeof extracted !== "object") {
    return jsonResponse(502, jsonError("Gemini upstream returned an empty response", "bad_gateway"));
  }

  const { text, reasoning, toolCalls, finish_reason, usage } = extracted as any;
  if (debug) {
    logDebug(debug, reqId, "gemini parsed", {
      finish_reason,
      textLen: typeof text === "string" ? text.length : 0,
      textPreview: typeof text === "string" ? previewString(text, 800) : "",
      reasoningLen: typeof reasoning === "string" ? reasoning.length : 0,
      reasoningPreview: typeof reasoning === "string" ? previewString(reasoning, 600) : "",
      toolCalls: toolCalls.map((c: any) => ({
        name: c.function?.name || "",
        id: c.id || "",
        argsLen: c.function?.arguments?.length || 0,
        hasThoughtSig: !!c.thought_signature,
      })),
      usage: usage || null,
      candidatesCount: Array.isArray((gjson as any)?.candidates) ? (gjson as any).candidates.length : 0,
      hasPromptFeedback: !!(gjson as any)?.promptFeedback,
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
  const toolCallsOut = toolCalls.map((c: any) => {
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

