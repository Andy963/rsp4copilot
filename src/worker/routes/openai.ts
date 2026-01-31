import type { Env } from "../../common";
import { jsonError, jsonResponse, joinUrls, logDebug, previewString, safeJsonStringifyForLog, sseHeaders } from "../../common";
import { getProviderApiKey } from "../../config";
import { dispatchOpenAIChatToProvider } from "../../dispatch";
import { resolveModel } from "../../model_resolver";
import { handleOpenAIRequest, handleOpenAIResponsesUpstream } from "../../providers/openai";
import { openAIChatResponseToResponses, responsesRequestToOpenAIChat } from "../../protocols/responses";
import { openAIChatSseToResponsesSse } from "../../protocols/stream";
import { copilotToolUseInstructionsText, readJsonBody, shouldInjectCopilotToolUseInstructions } from "../utils";
import type { RouteArgs } from "../types";

export async function handleOpenAIChatCompletionsRoute({ request, env, gatewayCfg, token, debug, reqId, path, startedAt }: RouteArgs): Promise<Response> {
  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }
  const reqJson = parsed.value as any;

  const model = reqJson.model;
  if (typeof model !== "string" || !model.trim()) return jsonResponse(400, jsonError("Missing required field: model"));

  const stream = Boolean(reqJson.stream);
  const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";

  if (gatewayCfg.ok && gatewayCfg.config) {
    const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
    const resolved = resolveModel(gatewayCfg.config, model, providerHint);
    if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);

    reqJson.model = resolved.model.upstreamModel;
    return await dispatchOpenAIChatToProvider({
      request,
      env,
      config: gatewayCfg.config,
      provider: resolved.provider,
      model: resolved.model,
      reqJson,
      stream,
      token,
      debug,
      reqId,
      path,
      startedAt,
      extraSystemText,
    });
  }

  return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
}

export async function handleOpenAITextCompletionsRoute({ request, env, gatewayCfg, token, debug, reqId, path, startedAt }: RouteArgs): Promise<Response> {
  if (!gatewayCfg.ok || !gatewayCfg.config) {
    return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }
  const reqJson = parsed.value as any;
  const model = reqJson.model;
  if (typeof model !== "string" || !model.trim()) return jsonResponse(400, jsonError("Missing required field: model"));

  const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
  const resolved = resolveModel(gatewayCfg.config, model, providerHint);
  if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);

  const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
  if (providerApiMode !== "openai-responses") {
    return jsonResponse(400, jsonError(`Unsupported apiMode for /v1/completions: ${providerApiMode || "(empty)"}`, "invalid_request_error"));
  }

  const apiKey = getProviderApiKey(env, resolved.provider);
  if (!apiKey) {
    return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error"));
  }

  const responsesPath =
    (resolved.provider.endpoints &&
      typeof (resolved.provider.endpoints as any).responsesPath === "string" &&
      String((resolved.provider.endpoints as any).responsesPath).trim()) ||
    (resolved.provider.endpoints &&
      typeof (resolved.provider.endpoints as any).responses_path === "string" &&
      String((resolved.provider.endpoints as any).responses_path).trim()) ||
    "";

  const modelOpts = resolved.model?.options || {};
  const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";

  const env2: Env = {
    ...env,
    OPENAI_BASE_URL: joinUrls(resolved.provider.baseURLs),
    OPENAI_API_KEY: apiKey,
    ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
    ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
  };

  const stream = Boolean(reqJson.stream);
  const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";

  return await handleOpenAIRequest({
    request,
    env: env2,
    reqJson,
    model: resolved.model.upstreamModel,
    stream,
    token,
    debug,
    reqId,
    path,
    startedAt,
    isTextCompletions: true,
    extraSystemText,
  });
}

export async function handleOpenAIResponsesRoute({ request, env, gatewayCfg, token, debug, reqId, path, startedAt }: RouteArgs): Promise<Response> {
  if (!gatewayCfg.ok || !gatewayCfg.config) {
    return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }
  const respReq = parsed.value as any;
  if (debug) {
    const input = Array.isArray(respReq?.input) ? respReq.input : [];
    const countType = (t: string) => input.filter((x) => x && typeof x === "object" && x.type === t).length;
    const reqLog = safeJsonStringifyForLog(respReq);
    logDebug(debug, reqId, "inbound responses body", {
      model: typeof respReq?.model === "string" ? respReq.model : "",
      stream: Boolean(respReq?.stream),
      hasPreviousResponseId: Boolean(typeof respReq?.previous_response_id === "string" && respReq.previous_response_id.trim()),
      inputItems: input.length,
      functionCallItems: countType("function_call"),
      functionCallOutputItems: countType("function_call_output"),
      hasTools: Array.isArray(respReq?.tools) && respReq.tools.length > 0,
      requestLen: reqLog.length,
      requestPreview: previewString(reqLog, 2400),
    });
  }
  const providerHint = respReq.provider ?? respReq.owned_by ?? respReq.ownedBy ?? respReq.owner ?? respReq.vendor;
  const resolved = resolveModel(gatewayCfg.config, respReq.model, providerHint);
  if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);

  const stream = Boolean(respReq.stream);
  const modelId = typeof respReq.model === "string" ? respReq.model : "";
  const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";

  // If the upstream is also OpenAI Responses, proxy it directly to preserve multimodal outputs (e.g. images).
  if (providerApiMode === "openai-responses") {
    const apiKey = getProviderApiKey(env, resolved.provider);
    if (!apiKey) {
      return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error"));
    }
    const responsesPath =
      (resolved.provider.endpoints &&
        typeof (resolved.provider.endpoints as any).responsesPath === "string" &&
        String((resolved.provider.endpoints as any).responsesPath).trim()) ||
      (resolved.provider.endpoints &&
        typeof (resolved.provider.endpoints as any).responses_path === "string" &&
        String((resolved.provider.endpoints as any).responses_path).trim()) ||
      "";

    const modelOpts = resolved.model?.options || {};
    const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";

    const env2: Env = {
      ...env,
      OPENAI_BASE_URL: joinUrls(resolved.provider.baseURLs),
      OPENAI_API_KEY: apiKey,
      ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
      ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
    };

    return await handleOpenAIResponsesUpstream({
      request,
      env: env2,
      reqJson: respReq,
      upstreamModel: resolved.model.upstreamModel,
      outModel: modelId,
      stream,
      token,
      debug,
      reqId,
      path,
      startedAt,
    });
  }

  const openaiReq = responsesRequestToOpenAIChat(respReq) as any;
  openaiReq.model = resolved.model.upstreamModel;
  openaiReq.stream = stream;

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
    const body = openAIChatSseToResponsesSse(openaiResp, modelId);
    return new Response(body, { status: 200, headers: sseHeaders() });
  }

  const openaiJson = await openaiResp.json().catch(() => null);
  if (!openaiJson || typeof openaiJson !== "object") return openaiResp;
  return jsonResponse(200, openAIChatResponseToResponses(openaiJson, modelId));
}

