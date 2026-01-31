import { joinPathPrefix, normalizeBaseUrl } from "../../common";
import { normalizeGeminiModelPath } from "./model";

export function buildGeminiGenerateContentUrl(rawBase: unknown, modelId: unknown, stream: boolean): string {
  const value = String(rawBase ?? "").trim();
  if (!value) return "";
  try {
    const normalized = normalizeBaseUrl(value);
    const u0 = new URL(normalized);
    let basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";

    // If configured as a full endpoint, keep it (just switch method based on stream).
    if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
      const method = stream ? "streamGenerateContent" : "generateContent";
      u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
      u0.search = "";
      u0.hash = "";
      if (stream) u0.searchParams.set("alt", "sse");
      return u0.toString();
    }

    const modelPath = normalizeGeminiModelPath(modelId);
    if (!modelPath) return "";

    // If base already contains a version segment, don't append again.
    if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
      basePath = joinPathPrefix(basePath, "/v1beta");
    }

    const method = stream ? "streamGenerateContent" : "generateContent";
    u0.pathname = joinPathPrefix(basePath, `/${modelPath}:${method}`);
    u0.search = "";
    u0.hash = "";
    if (stream) {
      u0.searchParams.set("alt", "sse");
    }
    return u0.toString();
  } catch {
    return "";
  }
}

export function splitCommaSeparatedUrls(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : "";
  return text
    .split(",")
    .map((v) => normalizeBaseUrl(v))
    .map((v) => v.trim())
    .filter(Boolean);
}

