import type { Env } from "../../common";
import { jsonError, jsonResponse, logDebug, normalizeAuthValue, previewString, sseHeaders } from "../../common";
import { normalizeGeminiContents } from "./contents";
import { normalizeGeminiModelIdForUpstream } from "./model";
import { buildGeminiGenerateContentUrl, splitCommaSeparatedUrls } from "./urls";

export async function handleGeminiGenerateContentUpstream({
  request,
  env,
  reqJson,
  model,
  stream,
  debug,
  reqId,
}: {
  request?: Request;
  env: Env;
  reqJson: any;
  model: string;
  stream: boolean;
  debug: boolean;
  reqId: string;
}): Promise<Response> {
  const geminiBases = splitCommaSeparatedUrls(env?.GEMINI_BASE_URL);
  if (!geminiBases.length) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_BASE_URL", "server_error"));

  const geminiKey = normalizeAuthValue(env?.GEMINI_API_KEY);
  if (!geminiKey) return jsonResponse(500, jsonError("Server misconfigured: missing GEMINI_API_KEY", "server_error"));

  const upstreamModelId = normalizeGeminiModelIdForUpstream(model);
  if (!upstreamModelId) return jsonResponse(400, jsonError("Missing required field: model", "invalid_request_error"));

  const body = { ...(reqJson && typeof reqJson === "object" ? reqJson : {}) };
  for (const k of Object.keys(body)) {
    if (k.startsWith("__")) delete (body as any)[k];
  }

  // Strip common gateway hints when present.
  delete (body as any).model;
  delete (body as any).stream;
  delete (body as any).provider;
  delete (body as any).owned_by;
  delete (body as any).ownedBy;

  // Validate that contents are non-empty and usable (Gemini requires at least one user turn).
  const normContents = normalizeGeminiContents((body as any).contents, { requireUser: true });
  if (!normContents.ok) return jsonResponse(400, jsonError(normContents.error, "invalid_request_error"));
  (body as any).contents = normContents.contents;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "rsp4copilot",
    "x-goog-api-key": geminiKey,
  };
  const xSessionId = request?.headers?.get?.("x-session-id");
  if (typeof xSessionId === "string" && xSessionId.trim()) headers["x-session-id"] = xSessionId.trim();

  let lastResp: Response | null = null;
  let lastErr: string | null = null;

  for (const base of geminiBases) {
    const geminiUrl = buildGeminiGenerateContentUrl(base, upstreamModelId, stream);
    if (!geminiUrl) continue;

    try {
      const resp = await fetch(geminiUrl, { method: "POST", headers, body: JSON.stringify(body) });
      if (resp.ok) {
        if (stream) return new Response(resp.body, { status: resp.status, headers: sseHeaders() });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } });
      }

      const errText = await resp.text().catch(() => "");
      lastResp = resp;
      lastErr = errText;
      const retryable = resp.status >= 500;
      if (debug) {
        logDebug(debug, reqId, "gemini upstream error", {
          upstreamUrl: geminiUrl,
          status: resp.status,
          retryable,
          errorPreview: previewString(errText, 1200),
        });
      }
      if (!retryable) {
        return new Response(errText, { status: resp.status, headers: { "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8" } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
      lastErr = message;
      if (debug) logDebug(debug, reqId, "gemini upstream fetch failed", { upstreamUrl: geminiUrl, error: message });
      continue;
    }
  }

  if (lastResp) {
    return new Response(lastErr || "", {
      status: lastResp.status || 502,
      headers: { "content-type": lastResp.headers.get("content-type") || "application/json; charset=utf-8" },
    });
  }

  return jsonResponse(502, jsonError(`Gemini upstream error: ${lastErr || "no upstream available"}`, "bad_gateway"));
}

