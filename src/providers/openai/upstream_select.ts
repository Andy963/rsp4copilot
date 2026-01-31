import { jsonError, logDebug, previewString, redactHeadersForLog } from "../../common";

function shouldRetryUpstream(status: any, bodyText: any = ""): boolean {
  // Only retry variants for likely "payload/shape mismatch" errors.
  // Avoid spamming many retries for path/auth errors that some relays report as 400/422.
  if (status !== 400 && status !== 422) return false;

  const text = typeof bodyText === "string" ? bodyText : bodyText == null ? "" : String(bodyText);
  if (!text.trim()) return true;

  const t = text.toLowerCase();
  const has = (s: string) => t.includes(s);

  // Path/routing style errors (seen in some gateways).
  if (has("no static resource")) return false;
  if (has("unknown route")) return false;
  if (has("route ") && has(" not found")) return false;
  if (has("method not allowed")) return false;
  if (has("not found")) return false;

  // Auth/permission errors (variants won't help).
  if (has("invalid api key")) return false;
  if (has("api key format")) return false;
  if (has("missing api key")) return false;
  if (has("unauthorized")) return false;
  if (has("forbidden")) return false;

  // Model not found errors (variants won't help).
  if (has("model_not_found")) return false;
  if (has("does not exist")) return false;
  if (has("unknown model")) return false;

  return true;
}

function shouldTryNextUpstreamUrl(status: any): boolean {
  // Gateways often return 403/404/405 for wrong paths; 502 for network/DNS.
  // Some gateways also return 400/422 for unhandled routes.
  return status === 400 || status === 422 || status === 403 || status === 404 || status === 405 || status === 500 || status === 502 || status === 503;
}

async function isProbablyEmptyEventStream(resp: Response): Promise<boolean> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const ct = (resp?.headers?.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream")) return false;
    if (!resp?.body) return true;

    const clone = resp.clone();
    const reader0 = clone.body?.getReader();
    if (!reader0) return true;
    reader = reader0;

    let bytesSeen = 0;
    const deadlineMs = 150;
    const startedAt = Date.now();

    type ReadWithTimeoutResult = { timeout: true } | { timeout: false; done: boolean; value?: Uint8Array };

    const readWithTimeout = (ms: number): Promise<ReadWithTimeoutResult> => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ timeout: true }), ms);
      });
      const read = reader0.read().then((r) => ({ timeout: false as const, ...r }));
      return (Promise.race([read, timeout]) as Promise<ReadWithTimeoutResult>).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    };

    while (Date.now() - startedAt < deadlineMs) {
      const remaining = Math.max(0, deadlineMs - (Date.now() - startedAt));
      const first = await readWithTimeout(Math.min(50, remaining));

      // If it hasn't produced anything quickly, assume it's not empty (could just be slow model output).
      if (first.timeout) return false;
      if (first.done) return bytesSeen === 0;
      const value = first.value;
      if (value && typeof value.length === "number") {
        if (value.length > 0) return false;
        // Some runtimes can yield a zero-length chunk; treat as inconclusive and keep reading briefly.
        bytesSeen += value.length;
      }
    }

    return false;
  } catch {
    return false;
  } finally {
    try {
      await reader?.cancel();
    } catch {}
  }
}

async function selectUpstreamResponse(
  upstreamUrl: string,
  headers: any,
  variants: any[],
  debug = false,
  reqId = "",
): Promise<{ ok: true; resp: Response; upstreamUrl: string } | { ok: false; status: number; error: any; upstreamUrl: string }> {
  let lastStatus = 502;
  let lastText = "";
  let firstErr: { status: number; text: string } | null = null; // { status, text }
  let exhaustedRetryable = false;
  let sawEmptyEventStream = false;

  const retryEmptySseAsNonStream = async (variantObj: any): Promise<Response | null> => {
    if (!variantObj || typeof variantObj !== "object") return null;

    const headers2 = { ...(headers && typeof headers === "object" ? headers : {}) };
    headers2.accept = "application/json";

    const v0 = variantObj;
    const tries: any[] = [];

    const vStreamFalse = { ...v0, stream: false };
    tries.push({ label: "stream:false", value: vStreamFalse });

    const vNoStream = { ...v0 };
    delete vNoStream.stream;
    tries.push({ label: "no-stream-field", value: vNoStream });

    for (let j = 0; j < tries.length; j++) {
      const t = tries[j];
      const body = JSON.stringify(t.value);
      if (debug) {
        logDebug(debug, reqId, "openai upstream empty-sse retry", {
          url: upstreamUrl,
          mode: t.label,
          bodyLen: body.length,
          bodyPreview: previewString(body, 1200),
        });
      }

      let resp2: Response;
      try {
        const t0 = Date.now();
        resp2 = await fetch(upstreamUrl, { method: "POST", headers: headers2, body });
        if (debug) {
          logDebug(debug, reqId, "openai upstream empty-sse retry response", {
            url: upstreamUrl,
            mode: t.label,
            status: resp2.status,
            ok: resp2.ok,
            contentType: resp2.headers.get("content-type") || "",
            elapsedMs: Date.now() - t0,
          });
        }
      } catch (err) {
        if (debug) {
          const message = err instanceof Error ? err.message : String(err ?? "fetch failed");
          logDebug(debug, reqId, "openai upstream empty-sse retry fetch failed", { url: upstreamUrl, mode: t.label, error: message });
        }
        continue;
      }

      // If it still comes back as an empty SSE, keep trying other modes.
      if (resp2.ok && (await isProbablyEmptyEventStream(resp2))) continue;

      // Return the first non-empty response (ok or error) so the caller can handle it.
      return resp2;
    }

    return null;
  };

  for (let i = 0; i < variants.length; i++) {
    const body = JSON.stringify(variants[i]);
    if (debug) {
      logDebug(debug, reqId, "openai upstream fetch", {
        url: upstreamUrl,
        variant: i,
        headers: redactHeadersForLog(headers),
        bodyLen: body.length,
        bodyPreview: previewString(body, 1200),
      });
    }
    let resp: Response;
    try {
      const t0 = Date.now();
      resp = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body,
      });
      if (debug) {
        logDebug(debug, reqId, "openai upstream response", {
          url: upstreamUrl,
          variant: i,
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get("content-type") || "",
          elapsedMs: Date.now() - t0,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "fetch failed";
      return { ok: false, status: 502, error: jsonError(`Upstream fetch failed: ${message}`, "bad_gateway"), upstreamUrl };
    }
    if (resp.ok && (await isProbablyEmptyEventStream(resp))) {
      sawEmptyEventStream = true;
      if (debug) {
        logDebug(debug, reqId, "openai upstream empty event stream", {
          url: upstreamUrl,
          variant: i,
          status: resp.status,
          contentType: resp.headers.get("content-type") || "",
          contentLength: resp.headers.get("content-length") || "",
        });
      }

      // Some relays incorrectly return `200 text/event-stream` with no events.
      // Retry the same request in non-stream mode to (a) possibly get a proper JSON response or (b) surface a real error body.
      const nonStream = await retryEmptySseAsNonStream(variants[i]);
      if (!nonStream) {
        lastStatus = 502;
        lastText = JSON.stringify(jsonError("Upstream returned an empty event stream", "bad_gateway"));
        if (!firstErr) firstErr = { status: lastStatus, text: lastText };
        continue;
      }

      resp = nonStream;
    }
    if (resp.status >= 400) {
      lastStatus = resp.status;
      lastText = await resp.text().catch(() => "");
      if (!firstErr) firstErr = { status: resp.status, text: lastText };
      if (shouldRetryUpstream(resp.status, lastText) && i + 1 < variants.length) continue;
      exhaustedRetryable = shouldRetryUpstream(resp.status, lastText) && i + 1 >= variants.length;
      try {
        const errText = exhaustedRetryable && firstErr ? firstErr.text : lastText;
        const errJson = JSON.parse(errText);
        const errStatus = exhaustedRetryable && firstErr ? firstErr.status : resp.status;
        return { ok: false, status: errStatus, error: errJson, upstreamUrl };
      } catch {
        const errStatus = exhaustedRetryable && firstErr ? firstErr.status : resp.status;
        return { ok: false, status: errStatus, error: jsonError(`Upstream error: HTTP ${errStatus}`), upstreamUrl };
      }
    }
    return { ok: true, resp, upstreamUrl };
  }
  if (sawEmptyEventStream && firstErr) {
    try {
      return { ok: false, status: firstErr.status, error: JSON.parse(firstErr.text), upstreamUrl };
    } catch {
      return { ok: false, status: firstErr.status, error: jsonError("Upstream returned an empty event stream", "bad_gateway"), upstreamUrl };
    }
  }
  if (exhaustedRetryable && firstErr) {
    try {
      return { ok: false, status: firstErr.status, error: JSON.parse(firstErr.text), upstreamUrl };
    } catch {
      return {
        ok: false,
        status: firstErr.status,
        error: jsonError(firstErr.text || `Upstream error: HTTP ${firstErr.status}`),
        upstreamUrl,
      };
    }
  }
  return { ok: false, status: lastStatus, error: jsonError(lastText || `Upstream error: HTTP ${lastStatus}`), upstreamUrl };
}

export async function selectUpstreamResponseAny(
  upstreamUrls: any,
  headers: any,
  variants: any,
  debug = false,
  reqId = "",
): Promise<{ ok: true; resp: Response; upstreamUrl: string } | { ok: false; status: number; error: any; upstreamUrl?: string }> {
  const urls = Array.isArray(upstreamUrls) ? upstreamUrls.filter(Boolean) : [];
  if (!urls.length) {
    return { ok: false, status: 500, error: jsonError("Server misconfigured: empty upstream URL list", "server_error") };
  }

  let firstErr: any | null = null;
  for (const url of urls) {
    if (debug) logDebug(debug, reqId, "openai upstream try", { url });
    const sel = await selectUpstreamResponse(url, headers, variants, debug, reqId);
    if (debug && !sel.ok) {
      logDebug(debug, reqId, "openai upstream try failed", {
        upstreamUrl: sel.upstreamUrl,
        status: sel.status,
        error: sel.error,
      });
    }
    if (sel.ok) return sel;
    if (!firstErr) firstErr = sel;
    if (!shouldTryNextUpstreamUrl(sel.status)) return sel;
  }
  return firstErr || { ok: false, status: 502, error: jsonError("Upstream error", "bad_gateway") };
}

