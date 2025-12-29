import { jsonError } from "./common";
import type { GatewayConfig, ModelConfig, ProviderConfig } from "./config";

export function splitProviderModel(
  modelId: unknown,
): { ok: true; providerId: string; modelName: string; error: "" } | { ok: false; providerId: ""; modelName: ""; error: string } {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return { ok: false, providerId: "", modelName: "", error: "Missing model" };
  if (raw.includes(":")) return { ok: false, providerId: "", modelName: "", error: "Invalid model: use providerId.modelName (':' is not allowed)" };
  const idx = raw.indexOf(".");
  if (idx <= 0 || idx === raw.length - 1) {
    return { ok: false, providerId: "", modelName: "", error: "Invalid model: must be providerId.modelName" };
  }
  const providerId = raw.slice(0, idx).trim();
  const modelName = raw.slice(idx + 1).trim();
  if (!providerId || !modelName) return { ok: false, providerId: "", modelName: "", error: "Invalid model: must be providerId.modelName" };
  return { ok: true, providerId, modelName, error: "" };
}

function normalizeProviderHint(hint: unknown): string {
  if (hint == null) return "";
  const v = typeof hint === "string" ? hint.trim() : String(hint).trim();
  return v;
}

function matchProviderByHint(
  config: GatewayConfig,
  hintRaw: unknown,
): { ok: true; providerId: string; provider: ProviderConfig; error: "" } | { ok: false; providerId: ""; provider: null; error: string } {
  const hint = normalizeProviderHint(hintRaw);
  if (!hint) return { ok: false, providerId: "", provider: null, error: "Missing provider" };

  const direct = config.providers[hint];
  if (direct) return { ok: true, providerId: hint, provider: direct, error: "" };

  const needle = hint.toLowerCase();
  const matches: Array<{ providerId: string; provider: ProviderConfig }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (providerId.toLowerCase() === needle) matches.push({ providerId, provider });
    else if ((provider?.ownedBy || "").toLowerCase() === needle) matches.push({ providerId, provider });
  }

  if (matches.length === 1) return { ok: true, providerId: matches[0].providerId, provider: matches[0].provider, error: "" };
  if (matches.length > 1) return { ok: false, providerId: "", provider: null, error: `Ambiguous provider: ${hint} (use provider id)` };
  return { ok: false, providerId: "", provider: null, error: `Unknown provider: ${hint}` };
}

export function resolveModel(
  config: GatewayConfig,
  modelId: unknown,
  providerHint?: unknown,
):
  | {
      ok: true;
      providerId: string;
      modelName: string;
      provider: ProviderConfig;
      model: ModelConfig;
    }
  | { ok: false; status: number; error: { error: { message: string; type: string; code: string } } } {
  const rawModel = typeof modelId === "string" ? modelId.trim() : "";
  if (!rawModel) return { ok: false, status: 400, error: jsonError("Missing model", "invalid_request_error") };
  if (rawModel.includes(":")) return { ok: false, status: 400, error: jsonError("Invalid model (':' is not allowed)", "invalid_request_error") };

  // Optional: explicit provider prefix (`providerId.modelName`).
  // NOTE: Many upstream model IDs contain dots (e.g. `gpt-5.2`, `gemini-1.5-pro`), so we only treat it as a
  // provider prefix if the prefix matches a configured provider id (or a unique `ownedBy`).
  if (rawModel.includes(".")) {
    const idx = rawModel.indexOf(".");
    const maybeProvider = rawModel.slice(0, idx).trim();
    const maybeModelName = rawModel.slice(idx + 1).trim();
    if (maybeProvider && maybeModelName) {
      const sel = matchProviderByHint(config, maybeProvider);
      if (sel.ok) {
        const model = sel.provider.models[maybeModelName];
        if (!model) {
          return { ok: false, status: 400, error: jsonError(`Unknown model for provider ${sel.providerId}: ${maybeModelName}`, "invalid_request_error") };
        }
        return { ok: true, providerId: sel.providerId, modelName: maybeModelName, provider: sel.provider, model };
      }
    }
  }

  // Preferred: separate `provider` + `model`
  const modelName = rawModel;
  const hint = normalizeProviderHint(providerHint);

  if (hint) {
    const sel = matchProviderByHint(config, hint);
    if (!sel.ok) return { ok: false, status: 400, error: jsonError(sel.error, "invalid_request_error") };
    const model = sel.provider.models[modelName];
    if (!model) return { ok: false, status: 400, error: jsonError(`Unknown model for provider ${sel.providerId}: ${modelName}`, "invalid_request_error") };
    return { ok: true, providerId: sel.providerId, modelName, provider: sel.provider, model };
  }

  // No provider hint: infer from config (must be unique)
  const matches: Array<{ providerId: string; provider: ProviderConfig; model: ModelConfig }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const m = provider?.models?.[modelName];
    if (m) matches.push({ providerId, provider, model: m });
  }

  if (!matches.length) return { ok: false, status: 400, error: jsonError(`Unknown model: ${modelName}`, "invalid_request_error") };
  if (matches.length > 1) {
    return {
      ok: false,
      status: 400,
      error: jsonError(`Ambiguous model: ${modelName} (provide 'provider' or use providerId.modelName)`, "invalid_request_error"),
    };
  }

  return { ok: true, providerId: matches[0].providerId, modelName, provider: matches[0].provider, model: matches[0].model };
}
