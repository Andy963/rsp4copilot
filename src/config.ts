import type { Env } from "./common";
import { normalizeAuthValue, normalizeBaseUrl } from "./common";
import { parseJsonc } from "./jsonc";

export interface ModelConfig {
  name: string;
  upstreamModel: string;
  options: Record<string, unknown>;
  quirks: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  type: string;
  ownedBy: string;
  baseURLs: string[];
  apiKeyEnv: string;
  apiKey: string;
  options: Record<string, unknown>;
  endpoints: Record<string, unknown>;
  quirks: Record<string, unknown>;
  models: Record<string, ModelConfig>;
}

export interface GatewayConfig {
  version: 1;
  providers: Record<string, ProviderConfig>;
}

function normalizeStringArrayOrString(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  const s = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return s ? [s] : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inferProviderOwnedBy(providerType: string, providerId: string): string {
  const t = typeof providerType === "string" ? providerType.trim().toLowerCase() : "";
  if (!t) return providerId;
  if (t.startsWith("openai")) return "openai";
  if (t === "claude") return "anthropic";
  if (t === "gemini") return "google";
  return providerId;
}

function normalizeProviderConfig(id: string, raw: unknown): ProviderConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  const ownedBy =
    (typeof (obj as any).ownedBy === "string" && String((obj as any).ownedBy).trim()) ||
    (typeof (obj as any).owned_by === "string" && String((obj as any).owned_by).trim()) ||
    (typeof (obj as any).provider === "string" && String((obj as any).provider).trim()) ||
    "";
  const baseURLs = normalizeStringArrayOrString((obj as any).baseURL ?? (obj as any).baseUrl ?? (obj as any).url);
  const apiKeyEnv = typeof (obj as any).apiKeyEnv === "string" ? String((obj as any).apiKeyEnv).trim() : "";
  const apiKey = typeof (obj as any).apiKey === "string" ? String((obj as any).apiKey).trim() : "";

  const options = isPlainObject((obj as any).options) ? ((obj as any).options as Record<string, unknown>) : {};
  const endpoints = isPlainObject((obj as any).endpoints) ? ((obj as any).endpoints as Record<string, unknown>) : {};
  const quirks = isPlainObject((obj as any).quirks) ? ((obj as any).quirks as Record<string, unknown>) : {};
  const models = isPlainObject((obj as any).models) ? ((obj as any).models as Record<string, unknown>) : {};

  return {
    id,
    type,
    ownedBy,
    baseURLs,
    apiKeyEnv,
    apiKey,
    options,
    endpoints,
    quirks,
    models: models as unknown as Record<string, ModelConfig>,
  };
}

function normalizeModelConfig(name: string, raw: unknown): ModelConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const upstreamModel = typeof (obj as any).upstreamModel === "string" ? String((obj as any).upstreamModel).trim() : "";
  const options = isPlainObject((obj as any).options) ? ((obj as any).options as Record<string, unknown>) : {};
  const quirks = isPlainObject((obj as any).quirks) ? ((obj as any).quirks as Record<string, unknown>) : {};
  return { name, upstreamModel: upstreamModel || name, options, quirks };
}

function readGatewayConfigRaw(env: Env): string {
  const primary = typeof (env as any)?.RSP4COPILOT_CONFIG === "string" ? String((env as any).RSP4COPILOT_CONFIG) : "";
  if (primary.trim()) return primary;
  return "";
}

export function parseGatewayConfig(env: Env):
  | { ok: true; config: GatewayConfig; source: "env"; error: "" }
  | { ok: false; config: null; source: "none" | "env"; error: string } {
  const raw = readGatewayConfigRaw(env);
  if (!raw.trim()) return { ok: false, config: null, source: "none", error: "Missing RSP4COPILOT_CONFIG" };

  const parsed = parseJsonc(raw);
  if (!parsed.ok) return { ok: false, config: null, source: "env", error: `Invalid config: ${parsed.error}` };

  const root = parsed.value;
  if (!isPlainObject(root)) return { ok: false, config: null, source: "env", error: "Config must be a JSON object" };

  const version = Number((root as any).version ?? 1);
  if (!Number.isFinite(version) || version !== 1) return { ok: false, config: null, source: "env", error: "Unsupported config version" };

  const providersRaw = isPlainObject((root as any).providers) ? ((root as any).providers as Record<string, unknown>) : null;
  if (!providersRaw) return { ok: false, config: null, source: "env", error: "Missing providers" };

  const providers: Record<string, ProviderConfig> = {};
  for (const [idRaw, pr] of Object.entries(providersRaw)) {
    const id = String(idRaw ?? "").trim();
    if (!id) continue;
    if (id.includes(".")) {
      return { ok: false, config: null, source: "env", error: `Provider id must not contain '.': ${id}` };
    }
    const p = normalizeProviderConfig(id, pr);
    if (!p.type) return { ok: false, config: null, source: "env", error: `Provider ${id}: missing type` };
    if (!p.baseURLs.length) return { ok: false, config: null, source: "env", error: `Provider ${id}: missing baseURL` };
    if (!p.ownedBy) p.ownedBy = inferProviderOwnedBy(p.type, id);

    // Normalize base URLs early.
    p.baseURLs = p.baseURLs
      .map((u) => normalizeBaseUrl(u))
      .map((u) => u.trim())
      .filter(Boolean);
    if (!p.baseURLs.length) return { ok: false, config: null, source: "env", error: `Provider ${id}: invalid baseURL` };

    if (!p.apiKey && !p.apiKeyEnv) {
      return { ok: false, config: null, source: "env", error: `Provider ${id}: missing apiKey or apiKeyEnv` };
    }

    const modelMap: Record<string, ModelConfig> = {};
    for (const [mnRaw, mr] of Object.entries(isPlainObject(p.models) ? p.models : {})) {
      const mn = String(mnRaw ?? "").trim();
      if (!mn) continue;
      modelMap[mn] = normalizeModelConfig(mn, mr);
    }
    p.models = modelMap;

    providers[id] = p;
  }

  if (!Object.keys(providers).length) return { ok: false, config: null, source: "env", error: "No providers configured" };

  return { ok: true, config: { version: 1, providers }, source: "env", error: "" };
}

export function getProviderApiKey(env: Env, provider: ProviderConfig): string {
  const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
  if (inline) return normalizeAuthValue(inline);
  const keyName = typeof provider?.apiKeyEnv === "string" ? provider.apiKeyEnv.trim() : "";
  if (!keyName) return "";
  return normalizeAuthValue((env as any)?.[keyName]);
}
