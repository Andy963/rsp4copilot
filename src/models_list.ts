import type { GatewayConfig } from "./config";

function collectModels(config: GatewayConfig): Array<{ providerId: string; modelName: string; ownedBy: string }> {
  const out: Array<{ providerId: string; modelName: string; ownedBy: string }> = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const ownedBy = typeof provider?.ownedBy === "string" && provider.ownedBy.trim() ? provider.ownedBy.trim() : providerId;
    for (const modelName of Object.keys(provider.models || {})) {
      out.push({ providerId, modelName, ownedBy });
    }
  }
  return out;
}

function countModelNames(models: Array<{ modelName: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of models) {
    counts.set(m.modelName, (counts.get(m.modelName) || 0) + 1);
  }
  return counts;
}

function modelIdForList(entry: { providerId: string; modelName: string }, counts: Map<string, number>): string {
  const count = counts.get(entry.modelName) || 0;
  if (count <= 1) return entry.modelName;
  return `${entry.providerId}.${entry.modelName}`;
}

export function openaiModelsList(config: GatewayConfig): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const models = collectModels(config);
  const nameCounts = countModelNames(models);
  const ids = models
    .map((m) => ({ id: modelIdForList(m, nameCounts), owned_by: m.ownedBy }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    object: "list",
    data: ids.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.owned_by })),
  };
}

export function geminiModelsList(config: GatewayConfig): {
  models: Array<{ name: string; displayName: string; supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }>;
} {
  const models = collectModels(config);
  const nameCounts = countModelNames(models);
  const ids = models
    .map((m) => modelIdForList(m, nameCounts))
    .sort((a, b) => a.localeCompare(b));
  return {
    models: ids.map((id) => ({
      name: `models/${id}`,
      displayName: id,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })),
  };
}
