import { jsonError, jsonResponse, logDebug, normalizeAuthValue, redactHeadersForLog, sseHeaders } from "../../common";
import { SseTextStreamParser } from "../../protocols/stream/sse";
import { selectUpstreamResponseAny } from "./upstream_select";
import { buildChatCompletionsUrls } from "./urls";

export async function handleOpenAIChatCompletionsUpstream({
  request,
  env,
  reqJson,
  model,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
  extraSystemText,
}: {
  request: Request;
  env: any;
  reqJson: any;
  model: string;
  stream: boolean;
  token: string;
  debug: boolean;
  reqId: string;
  path: string;
  startedAt: number;
  extraSystemText: string;
}): Promise<Response> {
  const upstreamBase = normalizeAuthValue(env?.OPENAI_BASE_URL);
  if (!upstreamBase) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_BASE_URL", "server_error"));
  const upstreamKey = normalizeAuthValue(env?.OPENAI_API_KEY);
  if (!upstreamKey) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_API_KEY", "server_error"));

  const upstreamUrls = buildChatCompletionsUrls(upstreamBase, env?.OPENAI_CHAT_COMPLETIONS_PATH);
  if (!upstreamUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid OPENAI_BASE_URL", "server_error"));
  if (debug) logDebug(debug, reqId, "openai chat-completions upstream urls", { urls: upstreamUrls });

  const body = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  body.model = model;
  body.stream = Boolean(stream);
  for (const k of Object.keys(body)) {
    if (k.startsWith("__")) delete body[k];
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${upstreamKey}`,
    "x-api-key": upstreamKey,
    "x-goog-api-key": upstreamKey,
  };
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) headers["x-session-id"] = xSessionId.trim();
  if (debug) logDebug(debug, reqId, "openai chat-completions upstream headers", { headers: redactHeadersForLog(headers) });

  if (extraSystemText && Array.isArray(body.messages)) {
    body.messages = [{ role: "system", content: extraSystemText }, ...body.messages];
  }

  void token;
  void path;
  void startedAt;

  const sel = await selectUpstreamResponseAny(upstreamUrls, headers, [body], debug, reqId);
  if (!sel.ok && debug) {
    logDebug(debug, reqId, "openai chat-completions upstream failed", { path, upstreamUrl: sel.upstreamUrl, status: sel.status, error: sel.error });
  }
  if (!sel.ok) return jsonResponse(sel.status, sel.error);

  const resp = sel.resp;
  if (stream) {
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream") || !resp.body) {
      return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
    }

    // Some OpenAI-compatible gateways may close the stream without emitting `data: [DONE]`.
    // Ensure we always terminate the SSE stream with `[DONE]` so clients that rely on it can finish.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      const sse = new SseTextStreamParser();
      let sawDone = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          for (const evt of sse.push(chunkText)) {
            if (evt.data === "[DONE]") sawDone = true;
          }
          await writer.write(encoder.encode(chunkText));
        }

        for (const evt of sse.finish()) {
          if (evt.data === "[DONE]") sawDone = true;
        }

        if (!sawDone) {
          await writer.write(encoder.encode("data: [DONE]\n\n"));
        }
      } catch {
        // Best-effort: if upstream ends unexpectedly, still try to close the client stream.
        try {
          if (!sawDone) await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch {}
      } finally {
        try {
          await reader.cancel();
        } catch {}
        try {
          await writer.close();
        } catch {}
      }
    })();

    return new Response(readable, { status: resp.status, headers: sseHeaders() });
  }

  const text = await resp.text();
  const outHeaders = { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" };
  return new Response(text, { status: resp.status, headers: outHeaders });
}
