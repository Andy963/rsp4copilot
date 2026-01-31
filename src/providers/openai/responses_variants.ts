import { normalizeMessageContent } from "../../common";

function responsesReqToPrompt(responsesReq: any): string {
  const parts: string[] = [];
  if (typeof responsesReq.instructions === "string" && responsesReq.instructions.trim()) {
    parts.push(responsesReq.instructions.trim());
  }
  if (Array.isArray(responsesReq.input)) {
    for (const item of responsesReq.input) {
      if (!item || typeof item !== "object") continue;
      const role = (item as any).role || "user";
      const text = normalizeMessageContent((item as any).content);
      if (text.trim()) parts.push(`${role}: ${text}`.trim());
    }
  }
  return parts.join("\n").trim();
}

export function responsesReqVariants(responsesReq: any, stream: boolean): any[] {
  const variants: any[] = [];
  const base = { ...responsesReq, stream: Boolean(stream) };
  variants.push(base);

  const maxOutput = base.max_output_tokens;
  const instructions = base.instructions;
  const input = base.input;
  const containsImages = (() => {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
      const content = (item as any)?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && (part as any).type === "input_image") return true;
      }
    }
    return false;
  })();
  const hasToolItems = (() => {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const t = (item as any).type;
      if (typeof t === "string" && (t === "function_call" || t === "function_call_output")) return true;
    }
    return false;
  })();

  if (Number.isInteger(maxOutput)) {
    const v = { ...base };
    delete v.max_output_tokens;
    v.max_tokens = maxOutput;
    variants.push(v);
  }

  if (typeof instructions === "string" && instructions.trim() && Array.isArray(input)) {
    const v = { ...base };
    delete v.instructions;
    v.input = [{ role: "system", content: [{ type: "input_text", text: instructions }] }, ...input];
    variants.push(v);
    if (Number.isInteger(maxOutput)) {
      const v2 = { ...v };
      delete v2.max_output_tokens;
      v2.max_tokens = maxOutput;
      variants.push(v2);
    }
  }

  if (Array.isArray(input) && !containsImages && !hasToolItems) {
    const stringInput = input
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const role = (item as any).role || "user";
        const txt = normalizeMessageContent((item as any).content);
        if (!txt || !String(txt).trim()) return null;
        return { role, content: txt };
      })
      .filter(Boolean);

    const v = { ...base, input: stringInput };
    variants.push(v);

    if (typeof instructions === "string" && instructions.trim()) {
      const v2 = { ...v };
      delete v2.instructions;
      v2.input = [{ role: "system", content: instructions }, ...stringInput];
      variants.push(v2);
    }
  }

  const prompt = responsesReqToPrompt(base);
  if (prompt && !containsImages && !hasToolItems) {
    const v = { ...base };
    delete v.instructions;
    v.input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
    variants.push(v);
  }

  // Some gateways expect `input_image.image_url` to be an object like `{ url }`.
  // If we detect images, add compatibility variants that rewrite that field.
  if (containsImages) {
    const imageObjVariants: any[] = [];
    for (const v of variants) {
      if (!v || typeof v !== "object" || !Array.isArray(v.input)) continue;
      let changed = false;
      const newInput = v.input.map((item: any) => {
        if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
        let contentChanged = false;
        const newContent = item.content.map((part: any) => {
          if (!part || typeof part !== "object" || part.type !== "input_image") return part;
          const iu = part.image_url;
          if (typeof iu === "string") {
            contentChanged = true;
            return { ...part, image_url: { url: iu } };
          }
          return part;
        });
        if (!contentChanged) return item;
        changed = true;
        return { ...item, content: newContent };
      });
      if (changed) imageObjVariants.push({ ...v, input: newInput });
    }
    variants.push(...imageObjVariants);
  }

  // Reasoning effort compatibility:
  // - Some gateways accept `reasoning: { effort }`
  // - Others accept `reasoning_effort: "<effort>"`
  // - If a gateway rejects reasoning params, try a no-reasoning fallback.
  const expanded: any[] = [];
  for (const v of variants) {
    expanded.push(v);
    if (!v || typeof v !== "object") continue;
    const objEffort = v.reasoning && typeof v.reasoning === "object" && typeof v.reasoning.effort === "string" ? v.reasoning.effort.trim() : "";
    const topEffort = typeof v.reasoning_effort === "string" ? v.reasoning_effort.trim() : "";
    const effort = objEffort || topEffort;
    if (!effort) continue;

    const asTop = { ...v, reasoning_effort: effort };
    delete asTop.reasoning;
    expanded.push(asTop);

    const asObj = { ...v, reasoning: { effort } };
    delete asObj.reasoning_effort;
    expanded.push(asObj);

    const noReasoning = { ...v };
    delete noReasoning.reasoning;
    delete noReasoning.reasoning_effort;
    expanded.push(noReasoning);
  }
  variants.length = 0;
  variants.push(...expanded);

  // Prompt caching / safety identifier compatibility:
  // Some relays reject unknown fields, so add progressively stripped variants as fallbacks.
  const cacheCompat: any[] = [];
  for (const v of variants) {
    cacheCompat.push(v);
    if (!v || typeof v !== "object") continue;

    const hasRetention = typeof v.prompt_cache_retention === "string" && v.prompt_cache_retention.trim();
    const hasSafety = typeof v.safety_identifier === "string" && v.safety_identifier.trim();
    if (!hasRetention && !hasSafety) continue;

    if (hasRetention) {
      const vNoRetention = { ...v };
      delete vNoRetention.prompt_cache_retention;
      cacheCompat.push(vNoRetention);
    }

    if (hasSafety) {
      const vNoSafety = { ...v };
      delete vNoSafety.safety_identifier;
      cacheCompat.push(vNoSafety);
    }

    const vNoCache = { ...v };
    delete vNoCache.prompt_cache_retention;
    delete vNoCache.safety_identifier;
    cacheCompat.push(vNoCache);
  }
  variants.length = 0;
  variants.push(...cacheCompat);

  const seen = new Set();
  const deduped: any[] = [];
  for (const v of variants) {
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  return deduped;
}

