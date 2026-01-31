import { jsonSchemaToGeminiSchema } from "./schema";

export function openaiToolsToGeminiFunctionDeclarations(tools: unknown): any[] {
  const out: any[] = [];
  const list = Array.isArray(tools) ? tools : [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    if ((t as any).type !== "function") continue;
    const fn = (t as any).function && typeof (t as any).function === "object" ? (t as any).function : null;
    const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const description = fn && typeof fn.description === "string" ? fn.description : undefined;
    const params = fn && fn.parameters && typeof fn.parameters === "object" ? fn.parameters : undefined;
    const decl: any = { name };
    if (description) decl.description = description;
    if (params) decl.parameters = jsonSchemaToGeminiSchema(params);
    out.push(decl);
  }
  return out;
}

export function openaiToolChoiceToGeminiToolConfig(toolChoice: any): any | null {
  if (toolChoice == null) return null;

  if (typeof toolChoice === "string") {
    const v = toolChoice.trim().toLowerCase();
    if (v === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (v === "required" || v === "any") return { functionCallingConfig: { mode: "ANY" } };
    // default: auto
    return { functionCallingConfig: { mode: "AUTO" } };
  }

  if (typeof toolChoice === "object") {
    const t = (toolChoice as any).type;
    if (t === "function") {
      const name = (toolChoice as any).function && typeof (toolChoice as any).function === "object" ? (toolChoice as any).function.name : "";
      if (typeof name === "string" && name.trim()) {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name.trim()] } };
      }
    }
  }

  return null;
}

