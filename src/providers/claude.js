import {
  appendInstructions,
  applyTemperatureTopPFromRequest,
  encodeSseData,
  getRsp4CopilotLimits,
  joinPathPrefix,
  jsonError,
  jsonResponse,
  logDebug,
  normalizeAuthValue,
  normalizeBaseUrl,
  normalizeMessageContent,
  previewString,
  redactHeadersForLog,
  safeJsonStringifyForLog,
  sseHeaders,
  trimOpenAIChatMessages,
} from "../common.js";

export function isClaudeModelId(modelId) {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "claude") return true;
  if (v === "claude-default") return true;
  if (v.startsWith("claude-")) return true;
  if (v.includes("/claude")) return true;
  if (v.includes("claude-")) return true;
  return false;
}

function normalizeClaudeModelId(modelId, env) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return env?.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-5-20250929";

  const lower = raw.toLowerCase();
  if (lower === "claude" || lower === "claude-default") {
    const dm = typeof env?.CLAUDE_DEFAULT_MODEL === "string" ? env.CLAUDE_DEFAULT_MODEL.trim() : "";
    return dm || "claude-sonnet-4-5-20250929";
  }

  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

function buildClaudeMessagesUrls(rawBase, messagesPathRaw) {
  const value = (rawBase || "").trim();
  if (!value) return [];

  const configuredPath = (messagesPathRaw || "").trim();

  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);

  const out = [];
  const pushUrl = (urlStr) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferMessagesPath = (basePath) => {
    const p = (basePath || "").replace(/\/+$/, "");
    if (p.endsWith("/v1")) return "/messages";
    return "/v1/messages";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const isFullEndpoint = basePath.endsWith("/v1/messages") || basePath.endsWith("/messages");

      if (isFullEndpoint) {
        u0.pathname = basePath;
        u0.search = "";
        u0.hash = "";
        pushUrl(u0.toString());
        continue;
      }

      const preferred = configuredPath ? (configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`) : inferMessagesPath(basePath);

      const candidates = configuredPath ? [joinPathPrefix(basePath, preferred)] : [joinPathPrefix(basePath, "/v1/messages")];

      for (const path of candidates) {
        const u = new URL(normalized);
        u.pathname = path;
        u.search = "";
        u.hash = "";
        pushUrl(u.toString());
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  return out;
}

function openaiChatToClaudeMessages(messages) {
  const claudeMessages = [];
  let systemText = "";

  for (const msg of messages) {
    const role = msg.role;
    if (role === "system") {
      const txt = normalizeMessageContent(msg.content);
      systemText += (systemText ? "\n\n" : "") + txt;
      continue;
    }

    // Handle tool result messages: group consecutive tool results into one Claude `user` message
    if (role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };

      const last = claudeMessages.length ? claudeMessages[claudeMessages.length - 1] : null;
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((p) => p && typeof p === "object" && p.type === "tool_result")) {
        last.content.push(toolResult);
      } else {
        claudeMessages.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    const claudeRole = role === "assistant" ? "assistant" : "user";
    const content = [];

    if (typeof msg.content === "string") {
      content.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") {
          content.push({ type: "text", text: part });
        } else if (part.type === "text") {
          content.push({ type: "text", text: part.text || "" });
        } else if (part.type === "image_url" && part.image_url?.url) {
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
            }
          }
        }
      }
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function" && tc.function) {
          let inputObj = {};
          try {
            inputObj = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: inputObj });
        }
      }
    }

    if (content.length) {
      claudeMessages.push({ role: claudeRole, content });
    }
  }

  const system = systemText.trim();
  return {
    messages: claudeMessages,
    system: system ? [{ type: "text", text: system }] : undefined,
  };
}

function openaiToolsToClaude(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

function claudeStopReasonToOpenai(stopReason) {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function claudeUsageToOpenaiUsage(usage) {
  return {
    prompt_tokens: usage?.input_tokens || 0,
    completion_tokens: usage?.output_tokens || 0,
    total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
  };
}

function claudeExtractTextAndToolCalls(content) {
  let text = "";
  const toolCalls = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        text += block.text || "";
      } else if (block.type === "thinking") {
        // Include thinking in response if present
        if (block.thinking) {
          text += (text ? "\n\n" : "") + "<think>\n" + block.thinking + "\n</think>";
        }
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
  }

  return { text, toolCalls };
}

export async function handleClaudeChatCompletions({ env, reqJson, model, stream, debug, reqId, extraSystemText }) {
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
      systemLen: typeof claudeSystem === "string" ? claudeSystem.length : 0,
      toolsCount: claudeTools.length,
      reqToolsCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
    });
  }

  let maxTokens = 8192;
  const maxTokensCap = typeof env.CLAUDE_MAX_TOKENS === "string" ? parseInt(env.CLAUDE_MAX_TOKENS, 10) : 8192;
  if (Number.isInteger(reqJson.max_tokens)) maxTokens = reqJson.max_tokens;
  if (Number.isInteger(reqJson.max_completion_tokens)) maxTokens = reqJson.max_completion_tokens;
  if (maxTokensCap > 0 && maxTokens > maxTokensCap) maxTokens = maxTokensCap;

  const claudeBody = {
    model: claudeModel,
    messages: claudeMessages,
    max_tokens: maxTokens,
    stream: stream,
  };
  if (claudeSystem) claudeBody.system = claudeSystem;
  if (claudeTools.length) claudeBody.tools = claudeTools;
  applyTemperatureTopPFromRequest(reqJson, claudeBody);

  const claudeHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${claudeKey}`,
    "x-api-key": claudeKey,
    "anthropic-version": "2023-06-01",
  };
  if (claudeTools.length) claudeHeaders["anthropic-beta"] = "tools-2024-04-04";
  if (debug) {
    const claudeBodyLog = safeJsonStringifyForLog(claudeBody);
    logDebug(debug, reqId, "claude request", {
      urlsCount: claudeUrls.length,
      headers: redactHeadersForLog(claudeHeaders),
      bodyLen: claudeBodyLog.length,
      bodyPreview: previewString(claudeBodyLog, 2400),
    });
  }

  let claudeResp = null;
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

    const message = { role: "assistant", content: text || null };
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
    const toolCalls = [];
    let finishReason = "stop";
    try {
      const reader = claudeResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallArgs = {}; // Map tool_use index to accumulated arguments
      let currentToolIndex = -1;

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

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              currentToolIndex = toolCalls.length;
              toolCalls.push({
                index: currentToolIndex,
                id: event.content_block.id,
                type: "function",
                function: { name: event.content_block.name, arguments: "" },
              });
              toolCallArgs[currentToolIndex] = "";
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
                          index: currentToolIndex,
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
            } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
              // Accumulate tool call arguments
              if (currentToolIndex >= 0) {
                toolCallArgs[currentToolIndex] = (toolCallArgs[currentToolIndex] || "") + event.delta.partial_json;
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
                            index: currentToolIndex,
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
            }
          } else if (event.type === "content_block_stop") {
            // Block finished, update tool call arguments if it was a tool_use
            if (currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
              toolCalls[currentToolIndex].function.arguments = toolCallArgs[currentToolIndex] || "{}";
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
