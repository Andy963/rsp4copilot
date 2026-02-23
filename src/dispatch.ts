import { joinUrls, jsonError, jsonResponse, normalizeAuthValue, readFirstStringField } from "./common";
import type { Env } from "./common";
import type { GatewayConfig, ModelConfig, ProviderConfig } from "./config";
import { getProviderApiKey } from "./config";
import { handleClaudeChatCompletions } from "./providers/claude";
import { handleGeminiChatCompletions } from "./providers/gemini";
import { handleOpenAIChatCompletionsUpstream, handleOpenAIRequest } from "./providers/openai";

function envWithOverrides(env: Env, overrides: Record<string, string> | null): Env {
  const base = env && typeof env === "object" ? env : {};
  return { ...base, ...(overrides && typeof overrides === "object" ? overrides : {}) };
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));
}

function pickNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v));
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

export async function dispatchOpenAIChatToProvider({
  request,
  env,
  config,
  provider,
  model,
  reqJson,
  stream,
  token,
  debug,
  reqId,
  path,
  startedAt,
  extraSystemText,
}: {
  request: Request;
  env: Env;
  config: GatewayConfig;
  provider: ProviderConfig;
  model: ModelConfig;
  reqJson: Record<string, unknown>;
  stream: boolean;
  token: string;
  debug: boolean;
  reqId: string;
  path?: string;
  startedAt?: number;
  extraSystemText: string;
}): Promise<Response> {
  const apiKey = getProviderApiKey(env, provider);
  if (!apiKey) return jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${provider.id}`, "server_error"));

  const providerApiMode = typeof provider.apiMode === "string" ? provider.apiMode.trim() : "";

  if (providerApiMode === "openai-responses") {
    const quirks = provider.quirks || {};
    const providerOpts = provider?.options || {};
    const modelOpts = model?.options || {};
    const responsesPath = readFirstStringField(provider.endpoints, "responsesPath", "responses_path");

    const upstreamUrls = joinUrls(provider.baseURLs);
    const noInstructionsUrls = truthy((quirks as any).noInstructions) ? upstreamUrls : "";
    const noPrevUrls = truthy((quirks as any).noPreviousResponseId) ? upstreamUrls : "";
    const reasoningEffort = typeof (modelOpts as any).reasoningEffort === "string" ? String((modelOpts as any).reasoningEffort).trim() : "";
    const maxInstructionsChars = pickNumber((modelOpts as any).maxInstructionsChars, (providerOpts as any).maxInstructionsChars);

    const env2 = envWithOverrides(env, {
      OPENAI_BASE_URL: upstreamUrls,
      OPENAI_API_KEY: apiKey,
      ...(responsesPath ? { RESP_RESPONSES_PATH: responsesPath } : null),
      ...(noInstructionsUrls ? { RESP_NO_INSTRUCTIONS_URLS: noInstructionsUrls } : null),
      ...(noPrevUrls ? { RESP_NO_PREVIOUS_RESPONSE_ID_URLS: noPrevUrls } : null),
      ...(reasoningEffort ? { RESP_REASONING_EFFORT: reasoningEffort } : null),
      ...(maxInstructionsChars != null ? { RESP_MAX_INSTRUCTIONS_CHARS: String(maxInstructionsChars) } : null),
    });

    const resp = await handleOpenAIRequest({
      request,
      env: env2,
      reqJson,
      model: model.upstreamModel,
      stream,
      token: normalizeAuthValue(token),
      debug,
      reqId,
      path: typeof path === "string" ? path : "",
      startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
      isTextCompletions: false,
      extraSystemText,
    });

    return resp;
  }

  if (providerApiMode === "openai-chat-completions") {
    const providerOpts = provider?.options || {};
    const modelOpts = model?.options || {};
    const chatCompletionsPath = readFirstStringField(provider.endpoints, "chatCompletionsPath", "chat_completions_path");
    const maxInstructionsChars = pickNumber((modelOpts as any).maxInstructionsChars, (providerOpts as any).maxInstructionsChars);

    const env2 = envWithOverrides(env, {
      OPENAI_BASE_URL: joinUrls(provider.baseURLs),
      OPENAI_API_KEY: apiKey,
      ...(chatCompletionsPath ? { OPENAI_CHAT_COMPLETIONS_PATH: chatCompletionsPath } : null),
      ...(maxInstructionsChars != null ? { RESP_MAX_INSTRUCTIONS_CHARS: String(maxInstructionsChars) } : null),
    });

    return await handleOpenAIChatCompletionsUpstream({
      request,
      env: env2,
      reqJson,
      model: model.upstreamModel,
      stream,
      token: normalizeAuthValue(token),
      debug,
      reqId,
      path: typeof path === "string" ? path : "",
      startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
      extraSystemText,
    });
  }

  if (providerApiMode === "claude") {
    const providerOpts = provider?.options || {};
    const modelOpts = model?.options || {};
    const messagesPath = readFirstStringField(provider.endpoints, "messagesPath", "messages_path");
    const claudeMaxTokens = pickNumber((modelOpts as any).maxTokens, (modelOpts as any).maxOutputTokens, (providerOpts as any).maxTokens, (providerOpts as any).maxOutputTokens);
    const env2 = envWithOverrides(env, {
      CLAUDE_BASE_URL: joinUrls(provider.baseURLs),
      CLAUDE_API_KEY: apiKey,
      ...(messagesPath ? { CLAUDE_MESSAGES_PATH: messagesPath } : null),
      ...(claudeMaxTokens != null ? { CLAUDE_MAX_TOKENS: String(claudeMaxTokens) } : null),
    });

    return await handleClaudeChatCompletions({
      request,
      env: env2,
      reqJson,
      model: model.upstreamModel,
      stream,
      debug,
      reqId,
      extraSystemText,
    });
  }

  if (providerApiMode === "gemini") {
    const env2 = envWithOverrides(env, {
      GEMINI_BASE_URL: joinUrls(provider.baseURLs),
      GEMINI_API_KEY: apiKey,
    });

    return await handleGeminiChatCompletions({
      request,
      env: env2,
      reqJson,
      model: model.upstreamModel,
      stream,
      token: normalizeAuthValue(token),
      debug,
      reqId,
      extraSystemText,
    });
  }

  return jsonResponse(500, jsonError(`Unsupported provider apiMode: ${providerApiMode}`, "server_error"));
}
