import type { Env } from "../../common";
import { jsonError, jsonResponse, joinUrls } from "../../common";
import { getProviderApiKey } from "../../config";
import { dispatchOpenAIChatToProvider } from "../../dispatch";
import { resolveModel } from "../../model_resolver";
import { handleGeminiGenerateContentUpstream } from "../../providers/gemini";
import { geminiRequestToOpenAIChat, openAIChatResponseToGemini } from "../../protocols/gemini";
import { openAIChatSseToGeminiSse } from "../../protocols/stream";
import type { RouteArgs } from "../types";
import { readJsonBody } from "../utils";

export async function handleGeminiGenerateContentRoute({ request, env, url, gatewayCfg, token, debug, reqId, path, startedAt }: RouteArgs): Promise<Response> {
  if (!gatewayCfg.ok || !gatewayCfg.config) {
    return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
  }
  const m = path.match(/^\/gemini\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
  if (!m) return jsonResponse(404, jsonError("Not found", "not_found"));

  const modelId = decodeURIComponent(m[1] || "");
  const methodName = m[2] || "generateContent";
  const stream = methodName === "streamGenerateContent";

  const providerHint = url.searchParams.get("provider") || url.searchParams.get("owned_by") || url.searchParams.get("ownedBy") || "";
  const resolved = resolveModel(gatewayCfg.config, modelId, providerHint);
  if (resolved.ok === false) return jsonResponse(resolved.status, resolved.error);

  const parsed = await readJsonBody(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return jsonResponse(400, jsonError("Invalid JSON body"));
  }

  const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
  if (providerApiMode === "gemini") {
    const apiKey = getProviderApiKey(env, resolved.provider);
    if (!apiKey) {
      return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error"));
    }
    const env2: Env = {
      ...env,
      GEMINI_BASE_URL: joinUrls(resolved.provider.baseURLs),
      GEMINI_API_KEY: apiKey,
    };
    return await handleGeminiGenerateContentUpstream({
      request,
      env: env2,
      reqJson: parsed.value,
      model: resolved.model.upstreamModel,
      stream,
      debug,
      reqId,
    });
  }

  const openaiReq = geminiRequestToOpenAIChat(parsed.value) as any;
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
    const body = openAIChatSseToGeminiSse(openaiResp);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }

  const openaiJson = await openaiResp.json().catch(() => null);
  if (!openaiJson || typeof openaiJson !== "object") return openaiResp;
  return jsonResponse(200, openAIChatResponseToGemini(openaiJson));
}

