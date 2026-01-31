import type { Env } from "../../common";
import { jsonError, jsonResponse, joinUrls } from "../../common";
import { claudeMessagesRequestToOpenaiChat, handleClaudeCountTokens, openaiChatResponseToClaudeMessage, openaiStreamToClaudeMessagesSse } from "../../claude_api";
import { getProviderApiKey } from "../../config";
import { dispatchOpenAIChatToProvider } from "../../dispatch";
import { resolveModel } from "../../model_resolver";
import type { RouteArgs } from "../types";
import { readJsonBody } from "../utils";

export async function handleClaudeMessagesRoute({ request, env, gatewayCfg, token, debug, reqId, path, startedAt }: RouteArgs): Promise<Response> {
  if (!gatewayCfg.ok || !gatewayCfg.config) {
    return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }
  const claudeReq = parsed.value as any;
  const providerHint = claudeReq.provider ?? claudeReq.owned_by ?? claudeReq.ownedBy ?? claudeReq.owner ?? claudeReq.vendor;
  const resolved = resolveModel(gatewayCfg.config, claudeReq.model, providerHint);
  if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);

  const converted = claudeMessagesRequestToOpenaiChat(claudeReq);
  if (converted.ok === false) return jsonResponse(converted.status, converted.error);

  const openaiReq = converted.req as any;
  openaiReq.model = resolved.model.upstreamModel;
  const stream = Boolean(openaiReq.stream);

  const openaiResp = await dispatchOpenAIChatToProvider({
    request,
    env,
    config: gatewayCfg.config,
    provider: resolved.provider,
    model: resolved.model,
    reqJson: openaiReq,
    stream,
    token,
    debug,
    reqId,
    path,
    startedAt,
    extraSystemText: "",
  });
  if (!openaiResp.ok) return openaiResp;

  if (stream) {
    const transformed = await openaiStreamToClaudeMessagesSse(openaiResp, { reqModel: resolved.model.upstreamModel, debug, reqId });
    if (!transformed.ok) return jsonResponse(transformed.status, transformed.error);
    return transformed.resp;
  }

  const openaiJson = await openaiResp.json().catch(() => null);
  if (!openaiJson || typeof openaiJson !== "object") return openaiResp;
  return jsonResponse(200, openaiChatResponseToClaudeMessage(openaiJson));
}

export async function handleClaudeCountTokensRoute({ request, env, gatewayCfg, debug, reqId }: RouteArgs): Promise<Response> {
  if (!gatewayCfg.ok || !gatewayCfg.config) {
    return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }
  const reqJson = parsed.value as any;
  const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
  const resolved = resolveModel(gatewayCfg.config, reqJson.model, providerHint);
  if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);
  reqJson.model = resolved.model.upstreamModel;

  const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
  if (providerApiMode !== "claude") {
    return jsonResponse(400, jsonError("count_tokens requires a claude provider", "invalid_request_error"));
  }

  const apiKey = getProviderApiKey(env, resolved.provider);
  if (!apiKey) {
    return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error"));
  }

  const messagesPath =
    resolved.provider.endpoints && typeof (resolved.provider.endpoints as any).messagesPath === "string"
      ? String((resolved.provider.endpoints as any).messagesPath).trim()
      : "";
  const env2: Env = {
    ...env,
    CLAUDE_BASE_URL: joinUrls(resolved.provider.baseURLs),
    CLAUDE_API_KEY: apiKey,
    ...(messagesPath ? { CLAUDE_MESSAGES_PATH: messagesPath } : null),
  };

  return await handleClaudeCountTokens({ request, env: env2, reqJson, debug, reqId });
}

