export function isGeminiModelId(modelId: unknown): boolean {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "gemini") return true;
  if (v === "gemini-default") return true;
  if (v.startsWith("gemini-")) return true;
  if (v.includes("/gemini")) return true;
  if (v.includes("gemini-")) return true;
  return false;
}

export function normalizeGeminiModelId(modelId: unknown, env: any): string {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return env?.GEMINI_DEFAULT_MODEL || "gemini-3-pro-preview";

  const lower = raw.toLowerCase();
  if (lower === "gemini" || lower === "gemini-default") {
    const dm = typeof env?.GEMINI_DEFAULT_MODEL === "string" ? env.GEMINI_DEFAULT_MODEL.trim() : "";
    return dm || "gemini-3-pro-preview";
  }

  // If the model is namespaced (e.g. "google/gemini-2.0-flash"), keep only the last segment.
  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

export function normalizeGeminiModelPath(modelId: unknown): string {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return "models/gemini-3-pro-preview";

  // Allow explicit "models/..." or "tunedModels/..."
  if (raw.startsWith("models/") || raw.startsWith("tunedModels/")) return raw;

  // Basic path sanitization (match Google SDK's restrictions).
  if (raw.includes("..") || raw.includes("?") || raw.includes("&")) return "";

  return `models/${raw}`;
}

export function normalizeGeminiModelIdForUpstream(modelId: unknown): string {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return "";

  // Preserve explicit Gemini API paths.
  if (raw.startsWith("models/") || raw.startsWith("tunedModels/")) return raw;

  // Strip provider namespaces like "google/gemini-3-flash-preview".
  const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
  return last;
}

