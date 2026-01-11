/**
 * rsp4copilot on Cloudflare Workers
 *
 * Inbound protocols:
 * - OpenAI Chat Completions: `POST /v1/chat/completions`
 * - OpenAI Responses:        `POST /v1/responses` (aliases: `/responses`, `/openai/v1/responses`)
 * - Claude Messages:         `POST /claude/v1/messages`, `POST /claude/v1/messages/count_tokens`
 * - Gemini:                  `POST /gemini/v1beta/models/{model}:generateContent`,
 *                            `POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`
 *
 * Routing:
 * - Config-driven (`modelName` or `providerId.modelName`) via `RSP4COPILOT_CONFIG` (required)
 */

import type { Env } from "./common";
import { bearerToken, getWorkerAuthKeys, isDebugEnabled, jsonError, jsonResponse, logDebug, normalizeAuthValue, previewString, sseHeaders } from "./common";
import { claudeMessagesRequestToOpenaiChat, handleClaudeCountTokens, openaiChatResponseToClaudeMessage, openaiStreamToClaudeMessagesSse } from "./claude_api";
import { getProviderApiKey, parseGatewayConfig } from "./config";
import { dispatchOpenAIChatToProvider } from "./dispatch";
import { resolveModel } from "./model_resolver";
import { geminiModelsList, openaiModelsList } from "./models_list";
import { handleGeminiGenerateContentUpstream } from "./providers/gemini";
import { handleOpenAIRequest, handleOpenAIResponsesUpstream } from "./providers/openai";
import { geminiRequestToOpenAIChat, openAIChatResponseToGemini } from "./protocols/gemini";
import { openAIChatResponseToResponses, responsesRequestToOpenAIChat } from "./protocols/responses";
import { openAIChatSseToGeminiSse, openAIChatSseToResponsesSse } from "./protocols/stream";

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = origin && typeof origin === "string" ? origin : "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-api-key,x-goog-api-key,anthropic-api-key,x-anthropic-api-key,anthropic-version,anthropic-beta",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(resp: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders || {})) {
    if (v == null) continue;
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(resp.body, { status: resp.status || 200, headers });
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: any } | { ok: false; value: null }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, value: null };
  }
}

function joinUrls(urls: unknown): string {
  const list = Array.isArray(urls) ? urls.map((u) => String(u ?? "").trim()).filter(Boolean) : [];
  return list.join(",");
}

function copilotToolUseInstructionsText(): string {
  return [
    "Tool use:",
    "- When tools are provided, use them to perform actions (file edits, patches, searches).",
    "- Do not say you will write/edit files and stop; call the relevant tool with valid JSON arguments.",
    "- Do not claim you changed files unless you actually called a tool and received a result.",
  ].join("\n");
}

function shouldInjectCopilotToolUseInstructions(request: Request, reqJson: any): boolean {
  const ua = request.headers.get("user-agent") || "";
  if (typeof ua !== "string") return false;
  if (!ua.toLowerCase().includes("oai-compatible-copilot/")) return false;
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  return tools.length > 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let reqId = "";
    try {
      reqId = crypto.randomUUID();
    } catch {
      reqId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    const debug = isDebugEnabled(env);
    const corsHeaders = getCorsHeaders(request);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const startedAt = Date.now();

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (debug) {
        const authHeader = request.headers.get("authorization") || "";
        const hasBearer = typeof authHeader === "string" && authHeader.toLowerCase().includes("bearer ");
        const xApiKey = request.headers.get("x-api-key") || "";
        logDebug(debug, reqId, "inbound request", {
          method: request.method,
          host: url.host,
          path,
          search: url.search || "",
          userAgent: request.headers.get("user-agent") || "",
          cfRay: request.headers.get("cf-ray") || "",
          hasAuthorization: Boolean(authHeader),
          authScheme: hasBearer ? "bearer" : authHeader ? "custom" : "",
          authorizationLen: typeof authHeader === "string" ? authHeader.length : 0,
          hasXApiKey: Boolean(xApiKey),
          xApiKeyLen: typeof xApiKey === "string" ? xApiKey.length : 0,
          contentType: request.headers.get("content-type") || "",
          contentLength: request.headers.get("content-length") || "",
        });
      }

      const workerAuthKeys = getWorkerAuthKeys(env);
      if (!workerAuthKeys.length) {
        return withCors(jsonResponse(500, jsonError("Server misconfigured: missing WORKER_AUTH_KEY/WORKER_AUTH_KEYS", "server_error")), corsHeaders);
      }

      const authHeader = request.headers.get("authorization");
      let token = bearerToken(authHeader);
      if (!token && typeof authHeader === "string") {
        const maybe = authHeader.trim();
        if (maybe && !maybe.includes(" ")) token = maybe;
      }
      if (!token) token = request.headers.get("x-api-key");
      if (!token) token = request.headers.get("x-goog-api-key");
      if (!token) token = request.headers.get("anthropic-api-key");
      if (!token) token = request.headers.get("x-anthropic-api-key");
      if (!token && path.startsWith("/gemini/")) token = url.searchParams.get("key");
      token = normalizeAuthValue(token);

      if (!token) {
        return withCors(jsonResponse(401, jsonError("Missing API key", "unauthorized"), { "www-authenticate": "Bearer" }), corsHeaders);
      }
      if (!workerAuthKeys.includes(token)) {
        return withCors(jsonResponse(401, jsonError("Unauthorized", "unauthorized"), { "www-authenticate": "Bearer" }), corsHeaders);
      }

      if (debug) {
        logDebug(debug, reqId, "auth ok", { tokenLen: token.length, authKeyCount: workerAuthKeys.length });
      }

      const gatewayCfg = parseGatewayConfig(env);

      if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
        return withCors(jsonResponse(200, { ok: true, time: Math.floor(Date.now() / 1000) }), corsHeaders);
      }

      // Models list
      if (
        request.method === "GET" &&
        (path === "/v1/models" || path === "/models" || path === "/openai/v1/models" || path === "/claude/v1/models")
      ) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        return withCors(jsonResponse(200, openaiModelsList(gatewayCfg.config)), corsHeaders);
      }
      if (request.method === "GET" && path === "/gemini/v1beta/models") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        return withCors(jsonResponse(200, geminiModelsList(gatewayCfg.config)), corsHeaders);
      }

      // OpenAI Chat Completions
      if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;

        const model = reqJson.model;
        if (typeof model !== "string" || !model.trim()) return withCors(jsonResponse(400, jsonError("Missing required field: model")), corsHeaders);

        const stream = Boolean(reqJson.stream);
        const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";

        if (gatewayCfg.ok && gatewayCfg.config) {
          const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
          const resolved = resolveModel(gatewayCfg.config, model, providerHint);
          if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

          reqJson.model = resolved.model.upstreamModel;
          const resp = await dispatchOpenAIChatToProvider({
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
          return withCors(resp, corsHeaders);
        }

        return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
      }

      // OpenAI Text Completions (legacy/compat)
      if (request.method === "POST" && (path === "/v1/completions" || path === "/completions")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;
        const model = reqJson.model;
        if (typeof model !== "string" || !model.trim()) return withCors(jsonResponse(400, jsonError("Missing required field: model")), corsHeaders);

        const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
        const resolved = resolveModel(gatewayCfg.config, model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode !== "openai-responses") {
          return withCors(
            jsonResponse(400, jsonError(`Unsupported apiMode for /v1/completions: ${providerApiMode || "(empty)"}`, "invalid_request_error")),
            corsHeaders,
          );
        }

        const apiKey = getProviderApiKey(env, resolved.provider);
        if (!apiKey) {
          return withCors(
            jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
            corsHeaders,
          );
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
        return withCors(
          await handleOpenAIRequest({
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
          }),
          corsHeaders,
        );
      }

      // OpenAI Responses
      if (request.method === "POST" && (path === "/v1/responses" || path === "/responses" || path === "/openai/v1/responses")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const respReq = parsed.value as any;
        const providerHint = respReq.provider ?? respReq.owned_by ?? respReq.ownedBy ?? respReq.owner ?? respReq.vendor;
        const resolved = resolveModel(gatewayCfg.config, respReq.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const stream = Boolean(respReq.stream);
        const modelId = typeof respReq.model === "string" ? respReq.model : "";
        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";

        // If the upstream is also OpenAI Responses, proxy it directly to preserve multimodal outputs (e.g. images).
        if (providerApiMode === "openai-responses") {
          const apiKey = getProviderApiKey(env, resolved.provider);
          if (!apiKey) {
            return withCors(
              jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
              corsHeaders,
            );
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

          const upstreamResp = await handleOpenAIResponsesUpstream({
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
          return withCors(upstreamResp, corsHeaders);
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
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const body = openAIChatSseToResponsesSse(openaiResp, modelId);
          return withCors(new Response(body, { status: 200, headers: sseHeaders() }), corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openAIChatResponseToResponses(openaiJson, modelId)), corsHeaders);
      }

      // Claude Messages
      if (request.method === "POST" && path === "/claude/v1/messages") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const claudeReq = parsed.value as any;
        const providerHint = claudeReq.provider ?? claudeReq.owned_by ?? claudeReq.ownedBy ?? claudeReq.owner ?? claudeReq.vendor;
        const resolved = resolveModel(gatewayCfg.config, claudeReq.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const converted = claudeMessagesRequestToOpenaiChat(claudeReq);
        if (converted.ok === false) return withCors(jsonResponse(converted.status, converted.error), corsHeaders);

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
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const transformed = await openaiStreamToClaudeMessagesSse(openaiResp, { reqModel: resolved.model.upstreamModel, debug, reqId });
          if (!transformed.ok) return withCors(jsonResponse(transformed.status, transformed.error), corsHeaders);
          return withCors(transformed.resp, corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openaiChatResponseToClaudeMessage(openaiJson)), corsHeaders);
      }

      if (request.method === "POST" && path === "/claude/v1/messages/count_tokens") {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }
        const reqJson = parsed.value as any;
        const providerHint = reqJson.provider ?? reqJson.owned_by ?? reqJson.ownedBy ?? reqJson.owner ?? reqJson.vendor;
        const resolved = resolveModel(gatewayCfg.config, reqJson.model, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);
        reqJson.model = resolved.model.upstreamModel;

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode !== "claude") {
          return withCors(jsonResponse(400, jsonError("count_tokens requires a claude provider", "invalid_request_error")), corsHeaders);
        }

        const apiKey = getProviderApiKey(env, resolved.provider);
        if (!apiKey) {
          return withCors(jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")), corsHeaders);
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

        const resp = await handleClaudeCountTokens({ request, env: env2, reqJson, debug, reqId });
        return withCors(resp, corsHeaders);
      }

      // Gemini
      if (request.method === "POST" && path.startsWith("/gemini/v1beta/models/")) {
        if (!gatewayCfg.ok || !gatewayCfg.config) {
          return withCors(jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error")), corsHeaders);
        }
        const m = path.match(/^\/gemini\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/);
        if (!m) return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);

        const modelId = decodeURIComponent(m[1] || "");
        const methodName = m[2] || "generateContent";
        const stream = methodName === "streamGenerateContent";

        const providerHint = url.searchParams.get("provider") || url.searchParams.get("owned_by") || url.searchParams.get("ownedBy") || "";
        const resolved = resolveModel(gatewayCfg.config, modelId, providerHint);
        if (resolved.ok === false) return withCors(jsonResponse(resolved.status, resolved.error), corsHeaders);

        const parsed = await readJsonBody(request);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return withCors(jsonResponse(400, jsonError("Invalid JSON body")), corsHeaders);
        }

        const providerApiMode = typeof resolved.provider.apiMode === "string" ? resolved.provider.apiMode.trim() : "";
        if (providerApiMode === "gemini") {
          const apiKey = getProviderApiKey(env, resolved.provider);
          if (!apiKey) {
            return withCors(
              jsonResponse(500, jsonError(`Server misconfigured: missing upstream API key for provider ${resolved.provider.id}`, "server_error")),
              corsHeaders,
            );
          }
          const env2: Env = {
            ...env,
            GEMINI_BASE_URL: joinUrls(resolved.provider.baseURLs),
            GEMINI_API_KEY: apiKey,
          };
          const upstreamResp = await handleGeminiGenerateContentUpstream({
            env: env2,
            reqJson: parsed.value,
            model: resolved.model.upstreamModel,
            stream,
            debug,
            reqId,
          });
          return withCors(upstreamResp, corsHeaders);
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
        if (!openaiResp.ok) return withCors(openaiResp, corsHeaders);

        if (stream) {
          const body = openAIChatSseToGeminiSse(openaiResp);
          return withCors(new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }), corsHeaders);
        }

        const openaiJson = await openaiResp.json().catch(() => null);
        if (!openaiJson || typeof openaiJson !== "object") return withCors(openaiResp, corsHeaders);
        return withCors(jsonResponse(200, openAIChatResponseToGemini(openaiJson)), corsHeaders);
      }

      if (request.method !== "POST") return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);
      return withCors(jsonResponse(404, jsonError("Not found", "not_found")), corsHeaders);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err ?? "unknown error");
      const stack = err instanceof Error ? err.stack : "";
      console.error(`[rsp4copilot][${reqId}] critical error: ${message}`, { stack });
      if (debug) logDebug(debug, reqId, "unhandled exception", { error: message, stack: previewString(stack, 2400) });
      return withCors(jsonResponse(500, jsonError(`Internal Server Error: ${message}`, "server_error")), corsHeaders);
    }
  },
};
