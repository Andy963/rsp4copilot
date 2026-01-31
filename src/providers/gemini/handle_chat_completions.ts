import type { Env } from "../../common";
import {
  getRsp4CopilotLimits,
  getSessionKey,
  jsonError,
  jsonResponse,
  logDebug,
  maskSecret,
  normalizeAuthValue,
  previewString,
  redactHeadersForLog,
  safeJsonStringifyForLog,
  trimOpenAIChatMessages,
} from "../../common";
import { normalizeGeminiContents } from "./contents";
import { normalizeGeminiModelId } from "./model";
import { getThoughtSignatureCache } from "./thought_signature_cache";
import { openaiChatToGeminiRequest } from "./request";
import { buildGeminiGenerateContentUrl } from "./urls";
import { handleGeminiChatCompletionsNonStream } from "./chat_nonstream";
import { handleGeminiChatCompletionsStream } from "./chat_stream";

export async function handleGeminiChatCompletions({
  request,
  env,
  reqJson,
  model,
  stream,
  token,
  debug,
  reqId,
  extraSystemText,
}: {
  request: Request;
  env: Env;
  reqJson: any;
  model: string;
  stream: boolean;
  token: string;
  debug: boolean;
  reqId: string;
  extraSystemText: string;
}): Promise<Response> {
  const geminiBase = normalizeAuthValue((env as any).GEMINI_BASE_URL);
  const geminiKey = normalizeAuthValue((env as any).GEMINI_API_KEY);
  if (!geminiBase) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_BASE_URL", "server_error"));
  if (!geminiKey) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_API_KEY", "server_error"));

  const geminiModelId = normalizeGeminiModelId(model, env);
  const geminiUrl = buildGeminiGenerateContentUrl(geminiBase, geminiModelId, stream);
  if (!geminiUrl) return jsonResponse(500, jsonError("Server misconfigured: invalid GEMINI_BASE_URL", "server_error"));

  const sessionKey = getSessionKey(request, reqJson, token);
  const thoughtSigCache = sessionKey ? await getThoughtSignatureCache(sessionKey) : {};

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
  const reqJsonForUpstream = trimRes.trimmed ? { ...reqJson, messages: trimRes.messages } : reqJson;

  let geminiBody: any;
  try {
    geminiBody = await openaiChatToGeminiRequest(reqJsonForUpstream, env, fetch, extraSystemText, thoughtSigCache);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to build Gemini request";
    return jsonResponse(400, jsonError(`Invalid request: ${message}`));
  }

  // Validate that contents are non-empty and usable (Gemini requires at least one user turn).
  const normContents = normalizeGeminiContents(geminiBody?.contents, { requireUser: true });
  if (!normContents.ok) return jsonResponse(400, jsonError(normContents.error, "invalid_request_error"));
  geminiBody.contents = normContents.contents;

  // Match Gemini's official auth style (and oai-compatible-copilot): API key in `x-goog-api-key`.
  // Some proxies mis-handle `Authorization` for Gemini and may return empty candidates.
  const geminiHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "rsp4copilot",
    "x-goog-api-key": geminiKey,
  };
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) geminiHeaders["x-session-id"] = xSessionId.trim();

  if (debug) {
    const geminiBodyLog = safeJsonStringifyForLog(geminiBody);
    logDebug(debug, reqId, "gemini request", {
      url: geminiUrl,
      originalModel: model,
      normalizedModel: geminiModelId,
      stream,
      sessionKey: sessionKey ? maskSecret(sessionKey) : "",
      thoughtSigCacheEntries: sessionKey ? Object.keys(thoughtSigCache).length : 0,
      headers: redactHeadersForLog(geminiHeaders),
      bodyLen: geminiBodyLog.length,
      bodyPreview: previewString(geminiBodyLog, 2400),
    });
  }

  let gemResp: Response;
  try {
    const t0 = Date.now();
    gemResp = await fetch(geminiUrl, { method: "POST", headers: geminiHeaders, body: JSON.stringify(geminiBody) });
    if (debug) {
      logDebug(debug, reqId, "gemini response headers", {
        status: gemResp.status,
        ok: gemResp.ok,
        contentType: gemResp.headers.get("content-type") || "",
        elapsedMs: Date.now() - t0,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    if (debug) logDebug(debug, reqId, "gemini fetch error", { error: message });
    return jsonResponse(502, jsonError(`Upstream fetch failed: ${message}`, "bad_gateway"));
  }

  if (!gemResp.ok) {
    let rawErr = "";
    try {
      rawErr = await gemResp.text();
    } catch {}
    if (debug) logDebug(debug, reqId, "gemini upstream error", { status: gemResp.status, errorPreview: previewString(rawErr, 1200) });
    let message = `Gemini upstream error (status ${gemResp.status})`;
    try {
      const obj = JSON.parse(rawErr);
      const m = obj?.error?.message ?? obj?.message;
      if (typeof m === "string" && m.trim()) message = m.trim();
    } catch {
      if (rawErr && rawErr.trim()) message = rawErr.trim().slice(0, 500);
    }
    const code = gemResp.status === 401 ? "unauthorized" : "bad_gateway";
    return jsonResponse(gemResp.status, jsonError(message, code));
  }

  if (!stream) {
    return await handleGeminiChatCompletionsNonStream({
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
    });
  }

  return handleGeminiChatCompletionsStream({
    gemResp,
    geminiBody,
    geminiHeaders,
    geminiBase,
    geminiModelId,
    model,
    sessionKey,
    debug,
    reqId,
  });
}

