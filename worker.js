/**
 * rsp4copilot on Cloudflare Workers
 * - Inbound: OpenAI-compatible `/v1/chat/completions`, `/v1/completions`, `/v1/models`
 * - Upstream: OpenAI Responses API (`/v1/responses`), streamed SSE
 * - Multi-turn: remembers `previous_response_id` in cache (best-effort)
 * - Vision: supports `image_url` parts -> Responses `input_image`
 *
 * Env vars (Wrangler):
 * - OPENAI_BASE_URL (upstream base URL or full Responses endpoint URL; can be comma-separated for fallback)
 * - RESP_RESPONSES_PATH (optional, defaults to "/v1/responses"; appended when OPENAI_BASE_URL is a base URL)
 * - RESP_REASONING_EFFORT (optional, e.g. "low" | "medium" | "high"; default: unset)
 * - OPENAI_API_KEY (upstream API key)
 * - GEMINI_BASE_URL (optional, Gemini API base URL for Gemini models, e.g. "https://example.com/gemini")
 * - GEMINI_API_KEY (optional, Gemini upstream API key)
 * - GEMINI_DEFAULT_MODEL (optional, default: "gemini-3-pro-preview")
 * - WORKER_AUTH_KEY (client auth key for this Worker)
 * - WORKER_AUTH_KEYS (optional, comma-separated; allows multiple client auth keys)
 * - DEFAULT_MODEL (optional)
 * - MODELS or ADAPTER_MODELS (optional, comma-separated)
 * - RSP4COPILOT_DEBUG (optional, "true"/"1" enables verbose debug logs)
 * - RSP4COPILOT_MAX_TURNS (optional, default: 12; set 0 to disable)
 * - RSP4COPILOT_MAX_MESSAGES (optional, default: 40; set 0 to disable)
 * - RSP4COPILOT_MAX_INPUT_CHARS (optional, default: 300000; set 0 to disable)
 */

import { bearerToken, getWorkerAuthKeys, isDebugEnabled, jsonError, jsonResponse, logDebug, normalizeAuthValue } from "./src/common.js";
import { handleClaudeChatCompletions, isClaudeModelId } from "./src/providers/claude.js";
import { handleGeminiChatCompletions, isGeminiModelId } from "./src/providers/gemini.js";
import { handleOpenAIRequest } from "./src/providers/openai.js";

function copilotToolUseInstructionsText() {
  return [
    "Tool use:",
    "- When tools are provided, use them to perform actions (file edits, patches, searches).",
    "- Do not say you will write/edit files and stop; call the relevant tool with valid JSON arguments.",
    "- Do not claim you changed files unless you actually called a tool and received a result.",
  ].join("\n");
}

function shouldInjectCopilotToolUseInstructions(request, reqJson) {
  const ua = request.headers.get("user-agent") || "";
  if (typeof ua !== "string") return false;
  if (!ua.toLowerCase().includes("oai-compatible-copilot/")) return false;
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  return tools.length > 0;
}

export default {
  async fetch(request, env) {
    let reqId = "";
    try {
      reqId = crypto.randomUUID();
    } catch {
      reqId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
    const debug = isDebugEnabled(env);

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const startedAt = Date.now();

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
        return jsonResponse(500, jsonError("Server misconfigured: missing WORKER_AUTH_KEY/WORKER_AUTH_KEYS", "server_error"));
      }

      const authHeader = request.headers.get("authorization");
      let token = bearerToken(authHeader);
      if (!token && typeof authHeader === "string") {
        // Allow `Authorization: <token>` (no scheme) if it's a single value.
        const maybe = authHeader.trim();
        if (maybe && !maybe.includes(" ")) token = maybe;
      }
      if (!token) token = request.headers.get("x-api-key");
      token = normalizeAuthValue(token);

      if (!token) {
        return jsonResponse(401, jsonError("Missing API key", "unauthorized"), { "www-authenticate": "Bearer" });
      }
      if (!workerAuthKeys.includes(token)) {
        return jsonResponse(401, jsonError("Unauthorized", "unauthorized"), { "www-authenticate": "Bearer" });
      }

      if (debug) {
        logDebug(debug, reqId, "auth ok", { tokenLen: token.length, authKeyCount: workerAuthKeys.length });
      }

      if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
        return jsonResponse(200, { ok: true, time: Math.floor(Date.now() / 1000) });
      }

      if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
        const modelsEnv = env.ADAPTER_MODELS || env.MODELS;
        const modelIds = modelsEnv
          ? modelsEnv.split(",").map((m) => m.trim()).filter(Boolean)
          : [env.DEFAULT_MODEL || "gpt-5.2"];
        if (debug) {
          logDebug(debug, reqId, "models list", { count: modelIds.length, defaultModel: env.DEFAULT_MODEL || "gpt-5.2" });
        }
        return jsonResponse(200, {
          object: "list",
          data: modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })),
        });
      }

      if (request.method !== "POST") {
        return jsonResponse(404, jsonError("Not found", "not_found"));
      }

      if (!(path === "/v1/chat/completions" || path === "/chat/completions" || path === "/v1/completions" || path === "/completions")) {
        return jsonResponse(404, jsonError("Not found", "not_found"));
      }

      let reqJson;
      try {
        reqJson = await request.json();
      } catch {
        return jsonResponse(400, jsonError("Invalid JSON body"));
      }
      if (!reqJson || typeof reqJson !== "object") return jsonResponse(400, jsonError("Invalid JSON body"));

      const model = reqJson.model;
      if (typeof model !== "string" || !model.trim()) return jsonResponse(400, jsonError("Missing required field: model"));

      const stream = Boolean(reqJson.stream);
      const isTextCompletions = path === "/v1/completions" || path === "/completions";
      const isChatCompletions = path === "/v1/chat/completions" || path === "/chat/completions";

      if (debug) {
        logDebug(debug, reqId, "request parsed", {
          model,
          stream,
          endpoint: isTextCompletions ? "completions" : isChatCompletions ? "chat.completions" : "unknown",
          hasTools: Array.isArray(reqJson.tools) && reqJson.tools.length > 0,
          toolCount: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
          hasToolChoice: reqJson.tool_choice != null,
          hasMessages: Array.isArray(reqJson.messages),
          messagesCount: Array.isArray(reqJson.messages) ? reqJson.messages.length : 0,
          hasPrompt: "prompt" in reqJson,
          maxTokens: Number.isInteger(reqJson.max_tokens)
            ? reqJson.max_tokens
            : Number.isInteger(reqJson.max_completion_tokens)
              ? reqJson.max_completion_tokens
              : null,
        });
      }

      const extraSystemText = shouldInjectCopilotToolUseInstructions(request, reqJson) ? copilotToolUseInstructionsText() : "";

      if (isChatCompletions && isGeminiModelId(model)) {
        return handleGeminiChatCompletions({ request, env, reqJson, model, stream, token, debug, reqId, extraSystemText });
      }

      if (isChatCompletions && isClaudeModelId(model)) {
        return handleClaudeChatCompletions({ env, reqJson, model, stream, debug, reqId, extraSystemText });
      }

      return handleOpenAIRequest({
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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "unknown error");
      logDebug(debug, reqId, "unhandled exception", { error: message });
      return jsonResponse(500, jsonError("Internal server error", "server_error"));
    }
  },
};
