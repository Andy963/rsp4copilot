function normalizeReasoningEffort(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v0 = raw.trim();
  if (!v0) return "";
  const v = v0.toLowerCase();
  if (v === "off" || v === "no" || v === "false" || v === "0" || v === "disable" || v === "disabled") return "";
  return v;
}

function normalizeNonEmptyString(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return v ? v : "";
}

function normalizePromptCacheRetention(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v0 = raw.trim();
  if (!v0) return "";
  const v = v0.toLowerCase();
  if (v === "24h" || v === "24hr" || v === "24hrs" || v === "24hours" || v === "24hour") return "24h";
  if (v === "in-memory" || v === "in_memory" || v === "inmemory" || v === "memory") return "in-memory";
  return v0;
}

export function getPromptCachingParams(reqJson: any): { prompt_cache_retention: string; safety_identifier: string } {
  const body = reqJson && typeof reqJson === "object" ? reqJson : {};
  const prompt_cache_retention = normalizePromptCacheRetention(body?.prompt_cache_retention ?? body?.promptCacheRetention);
  const safety_identifier = normalizeNonEmptyString(body?.safety_identifier ?? body?.safetyIdentifier);

  return { prompt_cache_retention, safety_identifier };
}

export function getReasoningEffort(reqJson: any, env: any): string {
  const body = reqJson && typeof reqJson === "object" ? reqJson : null;
  const hasReq =
    Boolean(body && ("reasoning_effort" in body || "reasoningEffort" in body)) ||
    Boolean(body && (body as any).reasoning && typeof (body as any).reasoning === "object" && "effort" in (body as any).reasoning);

  const fromReq =
    (body as any)?.reasoning_effort ??
    (body as any)?.reasoningEffort ??
    ((body as any)?.reasoning && typeof (body as any).reasoning === "object" ? (body as any).reasoning.effort : undefined);
  const reqEffort = normalizeReasoningEffort(String(fromReq ?? ""));
  if (reqEffort) return reqEffort;
  if (hasReq) return "";

  const envRaw = typeof env?.RESP_REASONING_EFFORT === "string" ? env.RESP_REASONING_EFFORT : "";
  const envEffort = normalizeReasoningEffort(envRaw);
  if (envEffort) return envEffort;
  if (envRaw && envRaw.trim()) return "";

  // Default: low (best-effort). If you want to send no reasoning params, set RESP_REASONING_EFFORT=off.
  return "low";
}

