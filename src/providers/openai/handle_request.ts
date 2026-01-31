import { getRsp4CopilotLimits, jsonError, jsonResponse, logDebug, normalizeAuthValue, redactHeadersForLog } from "../../common";
import { handleOpenAIChatCompletionsViaResponses } from "./handle_chat_completions";
import { handleOpenAITextCompletionsViaResponses } from "./handle_text_completions";
import { getPromptCachingParams, getReasoningEffort } from "./params";
import { buildUpstreamUrls } from "./urls";

export async function handleOpenAIRequest({
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
  isTextCompletions,
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
  isTextCompletions: boolean;
  extraSystemText: string;
}): Promise<Response> {
  const upstreamBase = normalizeAuthValue(env?.OPENAI_BASE_URL);
  if (!upstreamBase) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_BASE_URL", "server_error"));
  const upstreamKey = normalizeAuthValue(env?.OPENAI_API_KEY);
  if (!upstreamKey) return jsonResponse(500, jsonError("Server misconfigured: missing OPENAI_API_KEY", "server_error"));

  const upstreamUrls = buildUpstreamUrls(upstreamBase, env?.RESP_RESPONSES_PATH);
  if (!upstreamUrls.length) return jsonResponse(500, jsonError("Server misconfigured: invalid OPENAI_BASE_URL", "server_error"));
  if (debug) logDebug(debug, reqId, "openai upstream urls", { urls: upstreamUrls });

  // Some gateways (including Codex SDK style proxies) require upstream `stream: true`.
  // We can still serve non-stream clients by buffering the SSE output into a single JSON response.
  const upstreamStream = true;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: upstreamStream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${upstreamKey}`,
    "x-api-key": upstreamKey,
    "x-goog-api-key": upstreamKey,
    "openai-beta": "responses=v1",
  };
  const xSessionId = request.headers.get("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) headers["x-session-id"] = xSessionId.trim();
  if (debug) logDebug(debug, reqId, "openai upstream headers", { headers: redactHeadersForLog(headers) });

  const limits = getRsp4CopilotLimits(env);
  const reasoningEffort = getReasoningEffort(reqJson, env);
  const promptCache = getPromptCachingParams(reqJson);

  if (isTextCompletions) {
    return await handleOpenAITextCompletionsViaResponses({
      upstreamUrls,
      headers,
      upstreamStream,
      reqJson,
      model,
      stream,
      limits,
      reasoningEffort,
      promptCache,
      debug,
      reqId,
      path,
    });
  }

  return await handleOpenAIChatCompletionsViaResponses({
    request,
    upstreamUrls,
    headers,
    upstreamStream,
    reqJson,
    model,
    stream,
    token,
    limits,
    reasoningEffort,
    promptCache,
    debug,
    reqId,
    path,
    startedAt,
    extraSystemText,
  });
}

