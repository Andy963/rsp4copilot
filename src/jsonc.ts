export function stripJsonc(input: unknown): string {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  if (!text.trim()) return "";

  // Remove BOM
  let s = text.replace(/^\uFEFF/, "");

  // Strip /* ... */ comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");

  // Strip // ... comments (best-effort, ignores quotes edge cases)
  s = s.replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Strip trailing commas: { "a": 1, } or [1,2,]
  s = s.replace(/,\s*([}\]])/g, "$1");

  return s.trim();
}

export function parseJsonc(input: unknown): { ok: true; value: unknown; error: string } | { ok: false; value: null; error: string } {
  const stripped = stripJsonc(input);
  if (!stripped) return { ok: false, value: null, error: "Empty JSONC" };
  try {
    return { ok: true, value: JSON.parse(stripped), error: "" };
  } catch (e: unknown) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message?: unknown }).message) : "Invalid JSON";
    return { ok: false, value: null, error: msg };
  }
}

