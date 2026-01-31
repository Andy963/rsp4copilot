export function normalizeGeminiContents(
  rawContents: unknown,
  { requireUser = false }: { requireUser?: boolean } = {},
): { ok: true; contents: any[]; error: string } | { ok: false; contents: any[]; error: string } {
  const list = Array.isArray(rawContents) ? rawContents : [];
  const out: any[] = [];

  for (const c0 of list) {
    if (!c0 || typeof c0 !== "object") continue;
    const c = c0 as any;

    const roleRaw = typeof c.role === "string" ? c.role : "";
    const role = roleRaw && roleRaw.trim() ? roleRaw.trim() : "user";

    const partsIn = Array.isArray(c.parts) ? c.parts : [];
    const partsOut: any[] = [];

    for (const p0 of partsIn) {
      if (!p0 || typeof p0 !== "object") continue;
      const p = p0 as any;

      if (typeof p.text === "string") {
        if (p.text.trim()) partsOut.push(p0);
        continue;
      }

      const inlineData = p.inlineData && typeof p.inlineData === "object" ? p.inlineData : null;
      if (inlineData) {
        const data = typeof inlineData.data === "string" ? inlineData.data.trim() : "";
        if (data) partsOut.push(p0);
        continue;
      }

      const fileData = p.fileData && typeof p.fileData === "object" ? p.fileData : null;
      if (fileData) {
        const fileUri = typeof fileData.fileUri === "string" ? fileData.fileUri.trim() : "";
        if (fileUri) partsOut.push(p0);
        continue;
      }

      const fc = p.functionCall && typeof p.functionCall === "object" ? p.functionCall : null;
      if (fc) {
        const name = typeof fc.name === "string" ? fc.name.trim() : "";
        if (name) partsOut.push(p0);
        continue;
      }

      const fr = p.functionResponse && typeof p.functionResponse === "object" ? p.functionResponse : null;
      if (fr) {
        const name = typeof fr.name === "string" ? fr.name.trim() : "";
        if (name) partsOut.push(p0);
        continue;
      }

      // Unknown part type: keep it if it's not an empty object.
      if (Object.keys(p).length) partsOut.push(p0);
    }

    if (!partsOut.length) continue;
    out.push({ ...c0, role, parts: partsOut });
  }

  if (!out.length) {
    return { ok: false, contents: [], error: "At least one non-system message is required (contents array is empty)" };
  }

  if (requireUser) {
    const hasUser = out.some((c) => typeof (c as any)?.role === "string" && String((c as any).role).trim().toLowerCase() === "user");
    if (!hasUser) return { ok: false, contents: [], error: "At least one user message is required" };
  }

  return { ok: true, contents: out, error: "" };
}

