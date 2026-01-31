import { jsonError, jsonResponse, logDebug, normalizeAuthValue, redactHeadersForLog, sseHeaders } from "../../common";
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
    return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
  }

  const text = await resp.text();
  const outHeaders = { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" };
  return new Response(text, { status: resp.status, headers: outHeaders });
}

