import {
  appendInstructions,
  applyTemperatureTopPFromRequest,
  encodeSseData,
  getRsp4CopilotLimits,
  jsonError,
  jsonResponse,
  logDebug,
  normalizeAuthValue,
  previewString,
  redactHeadersForLog,
  safeJsonStringifyForLog,
  sseHeaders,
  trimOpenAIChatMessages,
} from "../../common";

import {
  buildClaudeMessagesUrls,
  claudeExtractTextAndToolCalls,
  claudeStopReasonToOpenai,
  claudeUsageToOpenaiUsage,
  normalizeClaudeModelId,
  openaiChatToClaudeMessages,
  openaiToolsToClaude,
} from "./convert";

export async function handleClaudeChatCompletions({
  request,
  env,
  reqJson,
  model,
  stream,
  debug,
  reqId,
  extraSystemText,
}: {
  request: Request;
  env: any;
  reqJson: any;
  model: string;
  stream: boolean;
  debug: boolean;
  reqId: string;
  extraSystemText: string;
}): Promise<Response> {
  const claudeBase = normalizeAuthValue(env.CLAUDE_BASE_URL);
  const claudeKey = normalizeAuthValue(env.CLAUDE_API_KEY);
  if (!claudeBase) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_BASE_URL", "server_error"));
  if (!claudeKey) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_API_KEY", "server_error"));

  const claudeUrls = buildClaudeMessagesUrls(claudeBase, env.CLAUDE_MESSAGES_PATH);
  if (debug) logDebug(debug, reqId, "claude upstream urls", { urls: claudeUrls });
  if (!claudeUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid CLAUDE_BASE_URL", "server_error"));

  const claudeModel = normalizeClaudeModelId(model, env);

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

  let { messages: claudeMessages, system: claudeSystem } = openaiChatToClaudeMessages(trimRes.messages);

  if (extraSystemText) {
    if (Array.isArray(claudeSystem) && claudeSystem.length > 0) {
      // If it's already an array, append to the last text block or add a new one
      const last = claudeSystem[claudeSystem.length - 1];
      if (last.type === "text") {
        last.text = appendInstructions(last.text, extraSystemText);
      } else {
        claudeSystem.push({ type: "text", text: extraSystemText });
      }
    } else {
      // If it was empty/undefined, create the array
      claudeSystem = [{ type: "text", text: extraSystemText }];
    }
  }

  const claudeTools = openaiToolsToClaude(reqJson.tools);

  if (debug) {
    logDebug(debug, reqId, "claude request build", {
      originalModel: model,
      normalizedModel: claudeModel,
      stream,
      messagesCount: claudeMessages.length,
      hasSystem: !!claudeSystem,
      systemLen: Array.isArray(claudeSystem) ? claudeSystem.length : 0,
      toolsCount: claudeTools.length,
      reqToolsCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
    });
  }

  let maxTokens = 8192;
  const maxTokensCap = typeof env.CLAUDE_MAX_TOKENS === "string" ? parseInt(env.CLAUDE_MAX_TOKENS, 10) : 8192;
  if (Number.isInteger(reqJson.max_tokens)) maxTokens = reqJson.max_tokens;
  if (Number.isInteger(reqJson.max_completion_tokens)) maxTokens = reqJson.max_completion_tokens;
  if (maxTokensCap > 0 && maxTokens > maxTokensCap) maxTokens = maxTokensCap;

  const claudeBody: any = {
    model: claudeModel,
    messages: claudeMessages,
    max_tokens: maxTokens,
    stream: stream,
  };
  if (claudeSystem) claudeBody.system = claudeSystem;
  if (claudeTools.length) claudeBody.tools = claudeTools;
  applyTemperatureTopPFromRequest(reqJson, claudeBody);

  const claudeHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${claudeKey}`,
    "x-api-key": claudeKey,
    "anthropic-version": "2023-06-01",
  };
  if (claudeTools.length) claudeHeaders["anthropic-beta"] = "tools-2024-04-04";
  const xSessionId = request?.headers?.get?.("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) claudeHeaders["x-session-id"] = xSessionId.trim();
  if (debug) {
    const claudeBodyLog = safeJsonStringifyForLog(claudeBody);
    logDebug(debug, reqId, "claude request", {
      urlsCount: claudeUrls.length,
      headers: redactHeadersForLog(claudeHeaders),
      bodyLen: claudeBodyLog.length,
      bodyPreview: previewString(claudeBodyLog, 2400),
    });
  }

  let claudeResp: Response | null = null;
  let claudeUrl = "";
  let lastClaudeError = "";
  for (const url of claudeUrls) {
    if (debug) logDebug(debug, reqId, "claude upstream try", { url });
    try {
      const t0 = Date.now();
      const resp = await fetch(url, { method: "POST", headers: claudeHeaders, body: JSON.stringify(claudeBody) });
      if (debug) {
        logDebug(debug, reqId, "claude upstream response", {
          url,
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get("content-type") || "",
          elapsedMs: Date.now() - t0,
        });
      }
      if (resp.ok) {
        claudeResp = resp;
        claudeUrl = url;
        break;
      }
      const errText = await resp.text().catch(() => "");
      lastClaudeError = errText;
      if (debug) logDebug(debug, reqId, "claude upstream error", { url, status: resp.status, errorPreview: previewString(errText, 1200) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
      lastClaudeError = message;
      if (debug) logDebug(debug, reqId, "claude fetch error", { url, error: message });
    }
  }

  if (!claudeResp) {
    return jsonResponse(502, jsonError("All Claude upstream URLs failed: " + lastClaudeError.slice(0, 200), "bad_gateway"));
  }

  const chatId = `chatcmpl_claude_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let cjson;
    try {
      cjson = await claudeResp.json();
    } catch {
      return jsonResponse(502, jsonError("Invalid JSON from Claude upstream", "bad_gateway"));
    }

    const { text, toolCalls } = claudeExtractTextAndToolCalls(cjson.content);
    const finishReason = claudeStopReasonToOpenai(cjson.stop_reason);
    const usage = claudeUsageToOpenaiUsage(cjson.usage);
    if (debug) {
      logDebug(debug, reqId, "claude parsed", {
        url: claudeUrl,
        finish_reason: finishReason,
        stop_reason: cjson.stop_reason || "",
        textLen: typeof text === "string" ? text.length : 0,
        textPreview: typeof text === "string" ? previewString(text, 800) : "",
        toolCalls: toolCalls.map((c) => ({ name: c.function?.name || "", id: c.id || "", argsLen: c.function?.arguments?.length || 0 })),
        usage: usage || null,
      });
    }

    const message: any = { role: "assistant", content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    return jsonResponse(200, {
      id: chatId,
      object: "chat.completion",
      created,
      model: claudeModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
  }

  // Streaming response
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const streamStartedAt = Date.now();
    let textContent = "";
    const toolCalls: any[] = [];
    let finishReason = "stop";
    const emitReasoningDelta = async (deltaText: unknown) => {
      if (typeof deltaText !== "string" || !deltaText) return;
      const chunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: claudeModel,
        choices: [{ index: 0, delta: { reasoning_content: deltaText }, finish_reason: null }],
      };
      await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
    };
    try {
      if (!claudeResp.body) throw new Error("Claude upstream returned an empty body");
      const reader = claudeResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallArgs: Record<number, string> = {};
      const toolCallIndexByBlockIndex = new Map<number, number>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              const blockIndex = Number.isInteger(event.index) ? event.index : null;
              if (blockIndex == null) continue;

              const toolIndex = toolCalls.length;
              toolCallIndexByBlockIndex.set(blockIndex, toolIndex);
              toolCalls.push({
                index: toolIndex,
                id: event.content_block.id,
                type: "function",
                function: { name: event.content_block.name, arguments: "" },
              });
              toolCallArgs[toolIndex] = "";
              // Send tool call start chunk
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: claudeModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: toolIndex,
                          id: event.content_block.id,
                          type: "function",
                          function: { name: event.content_block.name, arguments: "" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta" && event.delta.text) {
              textContent += event.delta.text;
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: claudeModel,
                choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
            } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
              await emitReasoningDelta(event.delta.thinking);
            } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
              const blockIndex = Number.isInteger(event.index) ? event.index : null;
              if (blockIndex == null) continue;

              const toolIndex = toolCallIndexByBlockIndex.get(blockIndex);
              if (toolIndex == null) continue;

              // Accumulate tool call arguments for this tool block
              toolCallArgs[toolIndex] = (toolCallArgs[toolIndex] || "") + event.delta.partial_json;
              // Send argument delta chunk
              const chunk = {
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: claudeModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: toolIndex,
                          function: { arguments: event.delta.partial_json },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              await writer.write(encoder.encode(encodeSseData(JSON.stringify(chunk))));
            }
          } else if (event.type === "content_block_stop") {
            const blockIndex = Number.isInteger(event.index) ? event.index : null;
            if (blockIndex == null) continue;

            const toolIndex = toolCallIndexByBlockIndex.get(blockIndex);
            if (toolIndex == null) continue;

            // Block finished, update tool call arguments if it was a tool_use
            if (toolCalls[toolIndex]) {
              toolCalls[toolIndex].function.arguments = toolCallArgs[toolIndex] || "{}";
            }
          } else if (event.type === "message_delta" && event.delta?.stop_reason) {
            finishReason = claudeStopReasonToOpenai(event.delta.stop_reason);
          }
        }
      }

      // Final chunk with finish_reason
      const finalChunk = {
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: claudeModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      await writer.write(encoder.encode(encodeSseData(JSON.stringify(finalChunk))));
      await writer.write(encoder.encode(encodeSseData("[DONE]")));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "stream error");
      if (debug) logDebug(debug, reqId, "claude stream error", { error: message });
    } finally {
      if (debug) {
        logDebug(debug, reqId, "claude stream summary", {
          url: claudeUrl,
          elapsedMs: Date.now() - streamStartedAt,
          textLen: textContent.length,
          toolCallsCount: toolCalls.length,
          finish_reason: finishReason,
        });
      }
      try {
        await writer.close();
      } catch {}
    }
  })();

  return new Response(readable, { status: 200, headers: sseHeaders() });
}
