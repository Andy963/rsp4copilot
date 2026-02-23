import type { Env } from "../common";
import { bearerToken, getWorkerAuthKeys, isDebugEnabled, jsonError, jsonResponse, logDebug, normalizeAuthValue, previewString } from "../common";
import { parseGatewayConfig } from "../config";
import { handleClaudeCountTokensRoute, handleClaudeMessagesRoute } from "./routes/claude";
import { handleGeminiGenerateContentRoute } from "./routes/gemini";
import { handleGeminiModelsListRoute, handleHealthRoute, handleOpenAIModelsListRoute } from "./routes/misc";
import { handleOpenAIChatCompletionsRoute, handleOpenAIResponsesRoute, handleOpenAITextCompletionsRoute } from "./routes/openai";
import type { RouteArgs } from "./types";
import { getCorsHeaders, redactUrlSearchForLog, withCors } from "./utils";

function generateReqId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function extractInboundToken(request: Request, path: string, url: URL): string {
  const authHeader = request.headers.get("authorization");

  let token = bearerToken(authHeader);
  if (!token && typeof authHeader === "string") {
    const maybe = authHeader.trim();
    if (maybe && !maybe.includes(" ")) token = maybe;
  }

  const headerCandidates = ["x-api-key", "x-goog-api-key", "anthropic-api-key", "x-anthropic-api-key"];
  for (const name of headerCandidates) {
    if (token) break;
    token = request.headers.get(name);
  }

  if (!token && path.startsWith("/gemini/")) token = url.searchParams.get("key");

  return normalizeAuthValue(token);
}

function normalizePathForPrefixMatch(pathname: string): string {
  const p = String(pathname || "").trim();
  return p.replace(/\/+$/, "") || "/";
}

function isPathPrefix(prefix: string, path: string): boolean {
  const pfx = normalizePathForPrefixMatch(prefix);
  const full = normalizePathForPrefixMatch(path);
  if (pfx === "/") return true;
  return full === pfx || full.startsWith(`${pfx}/`);
}

function findSelfForwardingProviders(gatewayCfg: { providers: Record<string, { baseURLs: string[] }> }, currentUrl: URL): Array<{ providerId: string; baseURL: string }> {
  const out: Array<{ providerId: string; baseURL: string }> = [];
  const currentOrigin = currentUrl.origin;
  const currentPath = normalizePathForPrefixMatch(currentUrl.pathname);

  for (const [providerId, provider] of Object.entries(gatewayCfg.providers || {})) {
    const baseUrls = Array.isArray(provider?.baseURLs) ? provider.baseURLs : [];
    for (const baseURL of baseUrls) {
      try {
        const u = new URL(baseURL);
        if (u.origin !== currentOrigin) continue;
        if (!isPathPrefix(u.pathname || "/", currentPath)) continue;
        out.push({ providerId, baseURL });
      } catch {
        // ignore invalid URLs here; config parsing should have validated already
      }
    }
  }

  return out;
}

export async function handleWorkerFetch(request: Request, env: Env): Promise<Response> {
  const reqId = generateReqId();
  const debug = isDebugEnabled(env);
  const corsHeaders = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const resp = await handleWorkerRequestNoCors({ request, env, debug, reqId });
  return withCors(resp, corsHeaders);
}

async function handleWorkerRequestNoCors({
  request,
  env,
  debug,
  reqId,
}: {
  request: Request;
  env: Env;
  debug: boolean;
  reqId: string;
}): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const startedAt = Date.now();

    if (request.method === "GET" && path === "/") {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>rsp4copilot</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.5; }
      .wrap { max-width: 920px; margin: 0 auto; padding: 28px 18px; }
      .card { border: 1px solid rgba(127,127,127,.35); border-radius: 12px; padding: 18px 16px; }
      h1 { margin: 0 0 8px; font-size: 22px; }
      p { margin: 8px 0; opacity: .92; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.95em; }
      ul { margin: 10px 0 0; padding-left: 18px; }
      li { margin: 4px 0; }
      .muted { opacity: .75; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>rsp4copilot</h1>
        <p>Status: <strong>running</strong></p>
        <p class="muted">This service requires authentication for API routes.</p>

        <p>Common endpoints:</p>
        <ul>
          <li><code>POST /v1/chat/completions</code></li>
          <li><code>POST /v1/completions</code></li>
          <li><code>POST /v1/responses</code> (aliases: <code>/responses</code>, <code>/openai/v1/responses</code>)</li>
          <li><code>POST /claude/v1/messages</code></li>
          <li><code>POST /claude/v1/messages/count_tokens</code></li>
          <li><code>POST /gemini/v1beta/models/{model}:generateContent</code></li>
          <li><code>POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse</code></li>
          <li><code>GET  /health</code></li>
        </ul>

        <p>Auth:</p>
        <ul>
          <li>Send your worker key as <code>Authorization: Bearer &lt;WORKER_AUTH_KEY&gt;</code></li>
          <li>Then use your upstream provider key in the upstream-specific headers/body as usual</li>
        </ul>
      </div>
    </div>
  </body>
</html>`;
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-rsp4copilot": "1",
        },
      });
    }

    if (debug) {
      const authHeader = request.headers.get("authorization") || "";
      const hasBearer = typeof authHeader === "string" && authHeader.toLowerCase().includes("bearer ");
      const xApiKey = request.headers.get("x-api-key") || "";
      logDebug(debug, reqId, "inbound request", {
        method: request.method,
        host: url.host,
        path,
        search: redactUrlSearchForLog(url),
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
    const workerAuthKeySet = new Set(workerAuthKeys);

    const token = extractInboundToken(request, path, url);

    if (!token) {
      return jsonResponse(401, jsonError("Missing API key", "unauthorized"), { "www-authenticate": "Bearer" });
    }
    if (!workerAuthKeySet.has(token)) {
      return jsonResponse(401, jsonError("Unauthorized", "unauthorized"), { "www-authenticate": "Bearer" });
    }

    if (debug) {
      logDebug(debug, reqId, "auth ok", { tokenLen: token.length, authKeyCount: workerAuthKeys.length });
    }

    const gatewayCfg = parseGatewayConfig(env);
    if (gatewayCfg.ok && gatewayCfg.config) {
      const loops = findSelfForwardingProviders(gatewayCfg.config, url);
      if (loops.length) {
        if (debug) logDebug(debug, reqId, "config loop guard triggered", loops[0]);
        return jsonResponse(
          500,
          jsonError(
            `Server misconfigured: provider ${loops[0].providerId} baseURL points to this worker (${loops[0].baseURL}); refusing to avoid an infinite routing loop`,
            "server_error",
          ),
        );
      }
    }

    if (request.method === "GET") {
      const health = handleHealthRoute(path);
      if (health) return health;

      const models = handleOpenAIModelsListRoute({ request, path, gatewayCfg });
      if (models) return models;

      const geminiModels = handleGeminiModelsListRoute({ request, path, gatewayCfg });
      if (geminiModels) return geminiModels;
    }

    const args: RouteArgs = { request, env, url, path, token, debug, reqId, startedAt, gatewayCfg };

    if (request.method === "POST") {
      if (path === "/v1/chat/completions" || path === "/chat/completions") return await handleOpenAIChatCompletionsRoute(args);
      if (path === "/v1/completions" || path === "/completions") return await handleOpenAITextCompletionsRoute(args);
      if (path === "/v1/responses" || path === "/responses" || path === "/openai/v1/responses") return await handleOpenAIResponsesRoute(args);

      if (path === "/claude/v1/messages") return await handleClaudeMessagesRoute(args);
      if (path === "/claude/v1/messages/count_tokens") return await handleClaudeCountTokensRoute(args);

      if (path.startsWith("/gemini/v1beta/models/")) return await handleGeminiGenerateContentRoute(args);
    }

    return jsonResponse(404, jsonError("Not found", "not_found"));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err ?? "unknown error");
    const stack = err instanceof Error ? err.stack : "";
    console.error(`[rsp4copilot][${reqId}] critical error: ${message}`, { stack });
    if (debug) logDebug(debug, reqId, "unhandled exception", { error: message, stack: previewString(stack, 2400) });
    return jsonResponse(500, jsonError("Internal Server Error", "server_error"), { "x-rsp4copilot-request-id": reqId });
  }
}
