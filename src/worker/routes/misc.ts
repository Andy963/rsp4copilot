import { jsonError, jsonResponse } from "../../common";
import { geminiModelsList, openaiModelsList } from "../../models_list";
import type { RouteArgs } from "../types";

export function handleHealthRoute(path: string): Response | null {
  if (path === "/health" || path === "/v1/health") {
    return jsonResponse(200, { ok: true, time: Math.floor(Date.now() / 1000) });
  }
  return null;
}

export function handleOpenAIModelsListRoute({ request, path, gatewayCfg }: Pick<RouteArgs, "request" | "path" | "gatewayCfg">): Response | null {
  if (
    request.method === "GET" &&
    (path === "/v1/models" || path === "/models" || path === "/openai/v1/models" || path === "/claude/v1/models")
  ) {
    if (!gatewayCfg.ok || !gatewayCfg.config) {
      return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
    }
    return jsonResponse(200, openaiModelsList(gatewayCfg.config));
  }
  return null;
}

export function handleGeminiModelsListRoute({ request, path, gatewayCfg }: Pick<RouteArgs, "request" | "path" | "gatewayCfg">): Response | null {
  if (request.method === "GET" && path === "/gemini/v1beta/models") {
    if (!gatewayCfg.ok || !gatewayCfg.config) {
      return jsonResponse(500, jsonError(gatewayCfg.error || "Server misconfigured: missing RSP4COPILOT_CONFIG", "server_error"));
    }
    return jsonResponse(200, geminiModelsList(gatewayCfg.config));
  }
  return null;
}

