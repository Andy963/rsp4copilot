import type { Env } from "./common";
import {
  jsonError,
  jsonResponse,
  joinPathPrefix,
  logDebug,
  normalizeAuthValue,
  normalizeBaseUrl,
  normalizeMessageContent,
  previewString,
  safeJsonStringifyForLog,
  sseHeaders,
} from "./common";

function encodeSseEvent(event: string, dataStr: string): string {
  return `event: ${event}\ndata: ${dataStr}\n\n`;
}

function parseSseLines(text: string): Array<{ event: string; data: string }> {
  const lines = String(text || "").split(/\r?\n/);
  const out: Array<{ event: string; data: string }> = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = () => {
    if (!event && !dataLines.length) return;
    const data = dataLines.join("\n");
    out.push({ event: event || "message", data });
    event = "";
    dataLines = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }
  flush();
  return out;
}

function openaiFinishReasonToClaude(stopReason: unknown): string {
  if (stopReason === "tool_calls") return "tool_use";
  if (stopReason === "length") return "max_tokens";
  if (stopReason === "stop") return "end_turn";
  return "end_turn";
}

function openaiToolChoiceFromClaude(toolChoice: any): any {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  const t = toolChoice.type;
  if (t === "auto") return "auto";
  if (t === "any") return "required";
  if (t === "tool") {
    const name = typeof toolChoice.name === "string" ? toolChoice.name.trim() : "";
    if (!name) return undefined;
    return { type: "function", function: { name } };
  }
  return undefined;
}

function openaiToolsFromClaude(tools: any): any[] {
  const list = Array.isArray(tools) ? tools : [];
  const out: any[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) continue;
    const description = typeof t.description === "string" ? t.description : "";
    const parameters = t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} };
    out.push({ type: "function", function: { name, description, parameters } });
  }
  return out;
}

function claudeSystemToOpenaiMessages(system: any): any[] {
  if (system == null) return [];
  if (typeof system === "string") {
    const txt = system.trim();
    return txt ? [{ role: "system", content: txt }] : [];
  }
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const b of system) {
      if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      }
    }
    const txt = parts.join("\n\n").trim();
    return txt ? [{ role: "system", content: txt }] : [];
  }
  return [];
}

function claudeContentBlocksToOpenaiParts(blocks: any): any {
  if (typeof blocks === "string") return blocks;
  const list = Array.isArray(blocks) ? blocks : [];
  const parts: any[] = [];
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      if (typeof b.text === "string") parts.push({ type: "text", text: b.text });
      continue;
    }
    if (b.type === "image") {
      const src = b.source;
      if (!src || typeof src !== "object") continue;
      if (src.type === "base64" && typeof src.data === "string" && src.data.trim()) {
        const mt = typeof src.media_type === "string" && src.media_type.trim() ? src.media_type.trim() : "image/png";
        const url = `data:${mt};base64,${src.data.trim()}`;
        parts.push({ type: "image_url", image_url: { url } });
      }
      continue;
    }
  }
  if (!parts.length) return "";
  return parts;
}

function claudeMessagesToOpenaiChatMessages(messages: any): any[] {
  const out: any[] = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;

    if (Array.isArray(content)) {
      const toolResultBlocks = content.filter((b) => b && typeof b === "object" && b.type === "tool_result");
      if (toolResultBlocks.length) {
        for (const tr of toolResultBlocks) {
          const id = typeof tr.tool_use_id === "string" ? tr.tool_use_id.trim() : "";
          if (!id) continue;
          const output = normalizeMessageContent(tr.content);
          out.push({ role: "tool", tool_call_id: id, content: output ?? "" });
        }
        const nonTool = content.filter((b) => !(b && typeof b === "object" && b.type === "tool_result"));
        if (!nonTool.length) continue;
        out.push({ role: "user", content: claudeContentBlocksToOpenaiParts(nonTool) });
        continue;
      }
    }

    if (role === "assistant" && Array.isArray(content)) {
      const toolCalls: any[] = [];
      const nonToolBlocks: any[] = [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_use") {
          const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : `call_${crypto.randomUUID().replace(/-/g, "")}`;
          const name = typeof b.name === "string" ? b.name : "";
          let args = "{}";
          try {
            args = JSON.stringify(b.input ?? {});
          } catch {}
          toolCalls.push({ id, type: "function", function: { name, arguments: args } });
          continue;
        }
        if (b.type === "tool_result") continue;
        nonToolBlocks.push(b);
      }
      const msgOut: any = { role: "assistant", content: claudeContentBlocksToOpenaiParts(nonToolBlocks) };
      if (toolCalls.length) msgOut.tool_calls = toolCalls;
      out.push(msgOut);
      continue;
    }

    out.push({ role, content: claudeContentBlocksToOpenaiParts(content) });
  }
  return out;
}

export function claudeMessagesRequestToOpenaiChat(reqJson: any): { ok: true; req: any } | { ok: false; status: number; error: any } {
  if (!reqJson || typeof reqJson !== "object") return { ok: false, status: 400, error: jsonError("Invalid JSON body") };
  const model = typeof reqJson.model === "string" ? reqJson.model : "";
  if (!model) return { ok: false, status: 400, error: jsonError("Missing required field: model") };

  const messages = claudeMessagesToOpenaiChatMessages(reqJson.messages);
  const systemMsgs = claudeSystemToOpenaiMessages(reqJson.system);
  const outMessages = [...systemMsgs, ...messages];

  const tools = openaiToolsFromClaude(reqJson.tools);
  const toolChoice = openaiToolChoiceFromClaude(reqJson.tool_choice);

  const maxTokens = typeof reqJson.max_tokens === "number" ? reqJson.max_tokens : typeof reqJson.max_output_tokens === "number" ? reqJson.max_output_tokens : undefined;

  return {
    ok: true,
    req: {
      model,
      messages: outMessages,
      stream: Boolean(reqJson.stream),
      tools: tools.length ? tools : undefined,
      tool_choice: toolChoice,
      max_tokens: maxTokens,
      temperature: reqJson.temperature,
      top_p: reqJson.top_p,
    },
  };
}

function openaiChatMessageToClaudeContent(msg: any): any[] {
  const parts: any[] = [];
  const content = msg?.content;
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
    return parts;
  }
  if (Array.isArray(content)) {
    for (const p of content) {
      if (typeof p === "string") {
        if (p) parts.push({ type: "text", text: p });
        continue;
      }
      if (!p || typeof p !== "object") continue;
      const t = p.type;
      if (t === "text") {
        if (typeof p.text === "string") parts.push({ type: "text", text: p.text });
        continue;
      }
      if (t === "image_url" && p.image_url?.url) {
        const url = p.image_url.url;
        if (typeof url === "string" && url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
          }
        }
      }
    }
  }
  return parts;
}

function openaiChatResponseToClaudeStopReason(chatJson: any): string {
  const choices = Array.isArray(chatJson?.choices) ? chatJson.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const fr = c0 && typeof c0.finish_reason === "string" ? c0.finish_reason : "";
  return openaiFinishReasonToClaude(fr);
}

export function openaiChatResponseToClaudeMessage(chatJson: any): any {
  const choices = Array.isArray(chatJson?.choices) ? chatJson.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const msg = c0 && typeof c0.message === "object" ? c0.message : null;
  const content = msg ? openaiChatMessageToClaudeContent(msg) : [];

  const usage = chatJson?.usage || undefined;
  return {
    id: chatJson?.id || `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: chatJson?.model || "",
    content,
    stop_reason: openaiChatResponseToClaudeStopReason(chatJson),
    usage,
  };
}

function extractOpenaiDeltaText(chunkObj: any): string {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? c0.delta : null;
  const content = delta?.content;
  return typeof content === "string" ? content : "";
}

function extractOpenaiFinishReason(chunkObj: any): string {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const fr = c0 && typeof c0.finish_reason === "string" ? c0.finish_reason : "";
  return fr;
}

function extractOpenaiToolCallDeltas(chunkObj: any): Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? c0.delta : null;
  const toolCalls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];

  const out: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const idx = Number.isInteger((tc as any).index) ? (tc as any).index : 0;
    const id = typeof (tc as any).id === "string" && String((tc as any).id).trim() ? String((tc as any).id).trim() : undefined;
    const fn = (tc as any).function && typeof (tc as any).function === "object" ? (tc as any).function : null;
    const name = fn && typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : undefined;
    const argsDelta = fn && typeof fn.arguments === "string" && fn.arguments ? fn.arguments : undefined;
    out.push({
      index: idx,
      ...(id ? { id } : null),
      ...(name ? { name } : null),
      ...(argsDelta ? { argumentsDelta: argsDelta } : null),
    });
  }
  return out;
}

export async function openaiStreamToClaudeMessagesSse(openAiResp: Response, opts: { reqModel: string; debug: boolean; reqId: string }): Promise<any> {
  const src = openAiResp?.body;
  if (!src) return { ok: false, status: 502, error: jsonError("Missing upstream body", "bad_gateway") };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const createdAt = Math.floor(Date.now() / 1000);
  const msgId = `msg_${Date.now().toString(36)}`;

  // Initial message event (Claude SSE usually starts with message_start)
  const startEvt = encodeSseEvent(
    "message_start",
    JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: opts.reqModel || "",
        content: [],
        stop_reason: null,
      },
    }),
  );
  await writer.write(encoder.encode(startEvt));

  (async () => {
    const reader = src.getReader();
    type ToolBlockState = {
      key: string;
      blockIndex: number;
      id: string;
      name: string;
      argsBuffer: string;
      started: boolean;
    };

    let stop_reason = "end_turn";
    let sawDone = false;

    let nextBlockIndex = 0;
    let textBlockIndex: number | null = null;
    const toolBlocks = new Map<string, ToolBlockState>();
    const startedBlockIndexes: number[] = [];
    const startedBlockSet = new Set<number>();
    const stoppedBlockSet = new Set<number>();

    const emitEvent = async (eventName: string, payload: unknown) => {
      const evt = encodeSseEvent(eventName, JSON.stringify(payload));
      await writer.write(encoder.encode(evt));
    };

    const startBlock = async (index: number, content_block: unknown) => {
      if (startedBlockSet.has(index)) return;
      startedBlockSet.add(index);
      startedBlockIndexes.push(index);
      await emitEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block,
      });
    };

    const stopBlock = async (index: number) => {
      if (stoppedBlockSet.has(index)) return;
      stoppedBlockSet.add(index);
      await emitEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      });
    };

    const ensureTextBlockStarted = async () => {
      if (textBlockIndex != null) return textBlockIndex;
      textBlockIndex = nextBlockIndex++;
      await startBlock(textBlockIndex, { type: "text", text: "" });
      return textBlockIndex;
    };

    const toolKeyFromDelta = (tc: { index: number; id?: string }) => {
      const id = typeof tc.id === "string" ? tc.id.trim() : "";
      if (id) return `id:${id}`;
      return `idx:${tc.index}`;
    };

    const ensureToolBlockStarted = async (st: ToolBlockState) => {
      if (st.started) return;
      const toolName = st.name || "unknown_tool";
      await startBlock(st.blockIndex, { type: "tool_use", id: st.id, name: toolName, input: {} });
      st.started = true;
      if (st.argsBuffer) {
        await emitEvent("content_block_delta", {
          type: "content_block_delta",
          index: st.blockIndex,
          delta: { type: "input_json_delta", partial_json: st.argsBuffer },
        });
        st.argsBuffer = "";
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const idx = buffer.lastIndexOf("\n\n");
        if (idx < 0) continue;
        const chunkText = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);

        for (const evt0 of parseSseLines(chunkText)) {
          const data = evt0.data;
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }
          let obj: any;
          try {
            obj = JSON.parse(data);
          } catch {
            continue;
          }

          const fr = extractOpenaiFinishReason(obj);
          if (fr) stop_reason = openaiFinishReasonToClaude(fr);

          const deltaText = extractOpenaiDeltaText(obj);
          if (deltaText) {
            const idx2 = await ensureTextBlockStarted();
            await emitEvent("content_block_delta", {
              type: "content_block_delta",
              index: idx2,
              delta: { type: "text_delta", text: deltaText },
            });
          }

          const tcs = extractOpenaiToolCallDeltas(obj);
          for (const tc of tcs) {
            const key = toolKeyFromDelta(tc);
            let st = toolBlocks.get(key);
            if (!st) {
              st = {
                key,
                blockIndex: nextBlockIndex++,
                id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                name: tc.name || "",
                argsBuffer: "",
                started: false,
              };
              toolBlocks.set(key, st);
            }

            if (!st.started && tc.id && tc.id.trim()) st.id = tc.id.trim();
            if (!st.name && tc.name) st.name = tc.name;

            if (!st.started && st.name) {
              await ensureToolBlockStarted(st);
            }

            if (typeof tc.argumentsDelta === "string" && tc.argumentsDelta) {
              if (st.started) {
                await emitEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: st.blockIndex,
                  delta: { type: "input_json_delta", partial_json: tc.argumentsDelta },
                });
              } else {
                st.argsBuffer += tc.argumentsDelta;
              }
            }
          }
        }

        if (sawDone) break;
      }
    } catch (err) {
      if (opts.debug) {
        const msg = err instanceof Error ? err.message : String(err ?? "stream error");
        logDebug(opts.debug, opts.reqId, "openai->claude stream error", { error: msg });
      }
    } finally {
      try {
        await reader.releaseLock();
      } catch {}

      try {
        await reader.cancel();
      } catch {}

      // Start any tool blocks that never got a name, so we don't drop buffered args.
      for (const st of toolBlocks.values()) {
        if (!st.started && (st.name || st.argsBuffer)) {
          await ensureToolBlockStarted(st);
        }
      }

      // Close any started blocks.
      for (const idx2 of startedBlockIndexes) {
        await stopBlock(idx2);
      }

      // message_delta
      await emitEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason,
          stop_sequence: null,
        },
      });

      // message_stop
      await emitEvent("message_stop", {
        type: "message_stop",
        message: { id: msgId },
      });

      try {
        await writer.close();
      } catch {}
    }
  })();

  return { ok: true, resp: new Response(readable, { status: 200, headers: sseHeaders() }) };
}

function buildClaudeCountTokensUrls(rawBase: unknown, messagesPathRaw: unknown): string[] {
  const value = typeof rawBase === "string" ? rawBase.trim() : "";
  if (!value) return [];

  const configuredMessagesPath = typeof messagesPathRaw === "string" ? messagesPathRaw.trim() : "";
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);

  const out: string[] = [];
  const pushUrl = (urlStr: unknown) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferMessagesPath = (basePath: string) => {
    const p = (basePath || "").replace(/\/+$/, "");
    if (p.endsWith("/v1")) return "/messages";
    return "/v1/messages";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";

      const messagesPath = configuredMessagesPath
        ? configuredMessagesPath.startsWith("/")
          ? configuredMessagesPath
          : `/${configuredMessagesPath}`
        : inferMessagesPath(basePath);
      const countTokensPath = joinPathPrefix(messagesPath, "/count_tokens");

      const u = new URL(normalized);
      u.pathname = countTokensPath;
      u.search = "";
      u.hash = "";
      pushUrl(u.toString());
    } catch {
      // ignore invalid urls
    }
  }

  return out;
}

function estimateTokensFromText(text: unknown): number {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!s) return 0;
  const bytes = new TextEncoder().encode(s).length;
  return Math.max(1, Math.ceil(bytes / 4));
}

function estimateClaudeInputTokens(reqJson: any): number {
  let tokens = 0;

  if (typeof reqJson?.system === "string") tokens += estimateTokensFromText(reqJson.system) + 6;
  if (Array.isArray(reqJson?.system)) {
    for (const b of reqJson.system) {
      if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") tokens += estimateTokensFromText(b.text);
    }
    tokens += 6;
  }

  const messages = Array.isArray(reqJson?.messages) ? reqJson.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    tokens += 4;
    tokens += estimateTokensFromText(m.role || "");

    const content = m.content;
    if (typeof content === "string") {
      tokens += estimateTokensFromText(content);
      continue;
    }
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const t = b.type;
      tokens += estimateTokensFromText(t || "");
      if (t === "text") {
        tokens += estimateTokensFromText(b.text || "");
      } else if (t === "tool_use") {
        tokens += estimateTokensFromText(b.name || "");
        try {
          tokens += estimateTokensFromText(JSON.stringify(b.input ?? {}));
        } catch {}
      } else if (t === "tool_result") {
        tokens += estimateTokensFromText(b.tool_use_id || "");
        tokens += estimateTokensFromText(normalizeMessageContent(b.content));
      } else if (t === "image") {
        tokens += 1500;
      }
    }
  }

  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    tokens += 6;
    tokens += estimateTokensFromText(t.name || "");
    tokens += estimateTokensFromText(t.description || "");
    try {
      tokens += estimateTokensFromText(JSON.stringify(t.input_schema ?? {}));
    } catch {}
  }

  return tokens;
}

export async function handleClaudeCountTokens({ request, env, reqJson, debug, reqId }: { request: Request; env: Env; reqJson: any; debug: boolean; reqId: string }): Promise<Response> {
  const base = normalizeAuthValue(env?.CLAUDE_BASE_URL);
  const key = normalizeAuthValue(env?.CLAUDE_API_KEY);
  if (!base) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_BASE_URL", "server_error"));
  if (!key) return jsonResponse(500, jsonError("Server misconfigured: missing CLAUDE_API_KEY", "server_error"));

  const urls = buildClaudeCountTokensUrls(base, env?.CLAUDE_MESSAGES_PATH);
  if (!urls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid CLAUDE_BASE_URL", "server_error"));

  const body: any = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  for (const k of Object.keys(body)) {
    if (k.startsWith("__")) delete body[k];
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };

  // Best-effort: if upstream fails, return a local estimate rather than 5xx.
  for (const url of urls) {
    try {
      if (debug) logDebug(debug, reqId, "claude count_tokens upstream try", { url });
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const txt = await resp.text();
      if (resp.ok) {
        return new Response(txt, { status: resp.status, headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } });
      }
      if (debug) logDebug(debug, reqId, "claude count_tokens upstream failed", { status: resp.status, bodyPreview: previewString(txt, 1200) });
    } catch (err) {
      if (debug) {
        const msg = err instanceof Error ? err.message : String(err ?? "fetch failed");
        logDebug(debug, reqId, "claude count_tokens upstream error", { error: msg });
      }
    }
  }

  const estimate = estimateClaudeInputTokens(body);
  const out = { input_tokens: estimate };
  if (debug) {
    logDebug(debug, reqId, "claude count_tokens local estimate", { tokens: estimate, reqPreview: previewString(safeJsonStringifyForLog(body), 1200) });
  }
  void request;
  return jsonResponse(200, out);
}

