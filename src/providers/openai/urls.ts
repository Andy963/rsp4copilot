import { joinPathPrefix, normalizeBaseUrl } from "../../common";

function normalizeDuplicateV1Segments(path: unknown): string {
  let p = typeof path === "string" ? path : path == null ? "" : String(path);
  if (!p) return p;

  // Normalize accidental double slashes first.
  p = p.replace(/\/{2,}/g, "/");

  // Collapse consecutive `/v1` segments (e.g. `/openai/v1/v1/responses` -> `/openai/v1/responses`).
  for (let i = 0; i < 6; i++) {
    const next = p.replace(/\/v1\/+v1(\/|$)/g, "/v1$1");
    if (next === p) break;
    p = next;
  }

  return p;
}

export function buildUpstreamUrls(raw: unknown, responsesPathRaw: unknown): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];

  const configuredResponsesPath = String(responsesPathRaw ?? "").trim();
  const hasConfiguredResponsesPath = Boolean(configuredResponsesPath);

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  const pushUrl = (urlStr: unknown) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferResponsesPath = (basePath: string) => {
    const p = (basePath || "").replace(/\/+$/, "");
    // Prefer `/v1/responses` unless the base already includes `/v1`.
    // Avoid generating `/v1/v1/responses` when a base already ends with `/v1` (or `/openai/v1`).
    if (p.endsWith("/openai/v1") || p.endsWith("/v1")) return "/responses";
    return "/v1/responses";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const rawPath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const base0 = normalizeDuplicateV1Segments(rawPath);

      const basePathsSet = new Set<string>();
      const pushBase = (bp: string) => {
        const v = normalizeDuplicateV1Segments((bp || "").replace(/\/+$/, "") || "/");
        if (!v) return;
        basePathsSet.add(v);
      };

      // Accept both "base URL" and "full endpoint" inputs, and generate safe fallbacks.
      pushBase(base0);
      if (base0.endsWith("/responses")) pushBase(base0.replace(/\/responses$/, "") || "/");
      for (const bp of Array.from(basePathsSet)) {
        if (bp.endsWith("/v1")) pushBase(bp.replace(/\/v1$/, "") || "/");
      }

      for (const basePath of Array.from(basePathsSet)) {
        const isFullEndpoint = basePath.endsWith("/v1/responses") || basePath.endsWith("/responses");

        if (isFullEndpoint) {
          const u = new URL(normalized);
          u.pathname = basePath;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
          continue;
        }

        // Treat as base/prefix: append responses path.
        // If a configured responses path is provided, treat it as authoritative (avoid overriding it with inferred fallbacks).
        const preferred = hasConfiguredResponsesPath
          ? configuredResponsesPath.startsWith("/")
            ? configuredResponsesPath
            : `/${configuredResponsesPath}`
          : inferResponsesPath(basePath);

        const candidatesRaw = hasConfiguredResponsesPath
          ? [joinPathPrefix(basePath, preferred)]
          : [joinPathPrefix(basePath, preferred), joinPathPrefix(basePath, "/v1/responses"), joinPathPrefix(basePath, "/responses")];

        const candidates = candidatesRaw
          .map((p) => normalizeDuplicateV1Segments(p))
          .filter((path) => !String(path || "").includes("/v1/v1/responses"))
          .sort((a, b) => {
            if (hasConfiguredResponsesPath) return 0;
            const score = (p: string) => (String(p || "").includes("/v1/responses") ? 0 : 1);
            return score(a) - score(b);
          });

        for (const path of candidates) {
          const u = new URL(normalized);
          u.pathname = path;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
        }
      }
    } catch {
      // Ignore invalid URLs; caller will handle empty list.
    }
  }

  return out;
}

export function buildChatCompletionsUrls(raw: unknown, chatPathRaw: unknown): string[] {
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (!value) return [];

  const configuredChatPath = typeof chatPathRaw === "string" ? chatPathRaw.trim() : "";

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  const pushUrl = (urlStr: unknown) => {
    if (!urlStr || typeof urlStr !== "string") return;
    if (!out.includes(urlStr)) out.push(urlStr);
  };

  const inferChatPath = (basePath: string) => {
    const p = (basePath || "").replace(/\/+$/, "");
    if (p.endsWith("/openai") || p.endsWith("/openai/v1")) return "/chat/completions";
    if (p.endsWith("/v1")) return "/chat/completions";
    return "/v1/chat/completions";
  };

  for (const p of parts) {
    try {
      const normalized = normalizeBaseUrl(p);
      const u0 = new URL(normalized);
      const rawPath = (u0.pathname || "").replace(/\/+$/, "") || "/";
      const base0 = normalizeDuplicateV1Segments(rawPath);

      const basePathsSet = new Set<string>();
      const pushBase = (bp: string) => {
        const v = normalizeDuplicateV1Segments((bp || "").replace(/\/+$/, "") || "/");
        if (!v) return;
        basePathsSet.add(v);
      };

      pushBase(base0);
      if (base0.endsWith("/chat/completions")) pushBase(base0.replace(/\/chat\/completions$/, "") || "/");
      for (const bp of Array.from(basePathsSet)) {
        if (bp.endsWith("/v1")) pushBase(bp.replace(/\/v1$/, "") || "/");
      }

      for (const basePath of Array.from(basePathsSet)) {
        const isFullEndpoint = basePath.endsWith("/v1/chat/completions") || basePath.endsWith("/chat/completions");

        if (isFullEndpoint) {
          const u = new URL(normalized);
          u.pathname = basePath;
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
          continue;
        }

        const preferred = configuredChatPath
          ? configuredChatPath.startsWith("/")
            ? configuredChatPath
            : `/${configuredChatPath}`
          : inferChatPath(basePath);
        const candidates = configuredChatPath
          ? [joinPathPrefix(basePath, preferred)]
          : [joinPathPrefix(basePath, preferred), joinPathPrefix(basePath, "/v1/chat/completions"), joinPathPrefix(basePath, "/chat/completions")];

        for (const path of candidates) {
          const u = new URL(normalized);
          u.pathname = normalizeDuplicateV1Segments(path);
          u.search = "";
          u.hash = "";
          pushUrl(u.toString());
        }
      }
    } catch {
      // Ignore invalid URLs; caller will handle empty list.
    }
  }

  return out;
}

