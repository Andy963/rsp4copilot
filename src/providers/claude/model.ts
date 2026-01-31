export function isClaudeModelId(modelId: unknown): boolean {
  const v = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (!v) return false;
  if (v === "claude") return true;
  if (v === "claude-default") return true;
  if (v.startsWith("claude-")) return true;
  if (v.includes("/claude")) return true;
  if (v.includes("claude-")) return true;
  return false;
}

