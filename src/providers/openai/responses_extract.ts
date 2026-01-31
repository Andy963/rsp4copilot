import { normalizeResponsesCallId } from "./thought_signature_cache";

export function extractOutputTextFromResponsesResponse(response: any): string {
  if (!response || typeof response !== "object") return "";

  const ot = response.output_text;
  if (typeof ot === "string" && ot) return ot;
  if (Array.isArray(ot)) {
    const joined = ot.filter((x: any) => typeof x === "string").join("");
    if (joined) return joined;
  }

  const parts: string[] = [];
  const push = (v: any) => {
    if (typeof v === "string" && v) parts.push(v);
  };

  const outputs = response.output;
  if (Array.isArray(outputs)) {
    for (const out of outputs) {
      if (!out || typeof out !== "object") continue;
      push(out.text);
      push(out.output_text);
      const content = out.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          push(c.text);
          push(c.output_text);
        }
      }
    }
  }

  const content = response.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      push(c.text);
      push(c.output_text);
    }
  }

  return parts.join("");
}

export function extractToolCallsFromResponsesResponse(response: any): any[] {
  const out: any[] = [];
  if (!response || typeof response !== "object") return out;

  const seen = new Set();
  const push = (callIdRaw: any, nameRaw: any, argsRaw: any) => {
    const callId = typeof callIdRaw === "string" && callIdRaw.trim() ? callIdRaw.trim() : "";
    if (!callId || seen.has(callId)) return;
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "";
    const args = typeof argsRaw === "string" ? argsRaw : argsRaw == null ? "" : String(argsRaw);
    out.push({ call_id: callId, name, arguments: args });
    seen.add(callId);
  };

  const visit = (item: any) => {
    if (!item || typeof item !== "object") return;

    const t = item.type;
    if (typeof t === "string" && t === "function_call") {
      push(item.call_id ?? item.callId ?? item.id, item.name ?? item.function?.name, item.arguments ?? item.function?.arguments);
      return;
    }

    const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : null;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        push(tc.id, tc.function?.name, tc.function?.arguments);
      }
    }
  };

  const outputs = response.output;
  if (Array.isArray(outputs)) {
    for (const item of outputs) visit(item);
  }

  return out;
}

export function extractThoughtSignatureUpdatesFromResponsesResponse(response: any): Record<string, { thought_signature: string; thought?: string; name?: string }> {
  const updates: Record<string, { thought_signature: string; thought?: string; name?: string }> = {};
  if (!response || typeof response !== "object") return updates;

  const outputs = Array.isArray(response.output) ? (response.output as any[]) : [];
  for (const item of outputs) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call") continue;

    const callId = normalizeResponsesCallId(item.call_id ?? item.callId ?? item.id);
    if (!callId) continue;

    const thoughtSigRaw = item.thought_signature ?? item.thoughtSignature;
    const thoughtSig = typeof thoughtSigRaw === "string" ? thoughtSigRaw.trim() : "";
    if (!thoughtSig) continue;

    const thoughtRaw = item.thought ?? item.reasoning ?? item.reasoning_content;
    const thought = typeof thoughtRaw === "string" ? thoughtRaw : "";
    const nameRaw = item.name ?? item.function?.name;
    const name = typeof nameRaw === "string" ? nameRaw : "";
    updates[callId] = { thought_signature: thoughtSig, ...(thought ? { thought } : {}), ...(name ? { name } : {}) };
  }

  return updates;
}

export function collectThoughtSignatureUpdatesFromResponsesSsePayload(payload: any, updates: any): void {
  if (!payload || typeof payload !== "object" || !updates || typeof updates !== "object") return;

  // Prefer the final response object when available.
  if ((payload as any).response && typeof (payload as any).response === "object") {
    Object.assign(updates, extractThoughtSignatureUpdatesFromResponsesResponse((payload as any).response));
    return;
  }

  // Some events include `item` with the output item object.
  const item = (payload as any).item;
  if (item && typeof item === "object" && (item as any).type === "function_call") {
    const callId = normalizeResponsesCallId((item as any).call_id ?? (item as any).callId ?? (item as any).id);
    const thoughtSigRaw = (item as any).thought_signature ?? (item as any).thoughtSignature;
    const thoughtSig = typeof thoughtSigRaw === "string" ? thoughtSigRaw.trim() : "";
    if (callId && thoughtSig) {
      const thoughtRaw = (item as any).thought ?? (item as any).reasoning ?? (item as any).reasoning_content;
      const thought = typeof thoughtRaw === "string" ? thoughtRaw : "";
      const nameRaw = (item as any).name ?? (item as any).function?.name;
      const name = typeof nameRaw === "string" ? nameRaw : "";
      (updates as any)[callId] = { thought_signature: thoughtSig, ...(thought ? { thought } : {}), ...(name ? { name } : {}) };
    }
    return;
  }

  // Some events include call info directly (e.g. response.function_call_arguments.done).
  const callId = normalizeResponsesCallId((payload as any).call_id ?? (payload as any).callId ?? (payload as any).id);
  const thoughtSigRaw = (payload as any).thought_signature ?? (payload as any).thoughtSignature;
  const thoughtSig = typeof thoughtSigRaw === "string" ? thoughtSigRaw.trim() : "";
  if (callId && thoughtSig) {
    const thoughtRaw = (payload as any).thought ?? (payload as any).reasoning ?? (payload as any).reasoning_content;
    const thought = typeof thoughtRaw === "string" ? thoughtRaw : "";
    const nameRaw = (payload as any).name;
    const name = typeof nameRaw === "string" ? nameRaw : "";
    (updates as any)[callId] = { thought_signature: thoughtSig, ...(thought ? { thought } : {}), ...(name ? { name } : {}) };
  }
}

export function extractFromResponsesSseText(
  sseText: any,
): { text: string; responseId: string | null; model: string | null; createdAt: number | null; toolCalls: any[] } {
  const text0 = typeof sseText === "string" ? sseText : "";
  const lines = text0.split("\n");
  let text = "";
  let responseId: string | null = null;
  let model: string | null = null;
  let createdAt: number | null = null;
  let sawDelta = false;
  let sawAnyText = false;
  const toolCalls: any[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") break;
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const evt = payload?.type;

    if (evt === "response.created" && payload?.response && typeof payload.response === "object") {
      const rid = payload.response.id;
      if (typeof rid === "string" && rid) responseId = rid;
      const m = payload.response.model;
      if (typeof m === "string" && m) model = m;
      const c = payload.response.created_at;
      if (Number.isInteger(c)) createdAt = c;
      continue;
    }

    if (evt === "response.function_call_arguments.delta") {
      const callId = payload.call_id ?? payload.callId ?? payload.id;
      const name = payload.name;
      const delta = payload.delta;
      if (typeof callId === "string" && callId.trim()) {
        toolCalls.push({
          call_id: callId.trim(),
          name: typeof name === "string" ? name : "",
          arguments: typeof delta === "string" ? delta : "",
        });
      }
      continue;
    }

    if ((evt === "response.output_text.delta" || evt === "response.refusal.delta") && typeof payload.delta === "string") {
      sawDelta = true;
      sawAnyText = true;
      text += payload.delta;
      continue;
    }
    if (!sawDelta && (evt === "response.output_text.done" || evt === "response.refusal.done") && typeof payload.text === "string") {
      sawAnyText = true;
      text += payload.text;
      continue;
    }
    if (evt === "response.completed" && payload?.response && typeof payload.response === "object") {
      const rid = payload.response.id;
      if (!responseId && typeof rid === "string" && rid) responseId = rid;
      if (!sawDelta && !sawAnyText) {
        const t = extractOutputTextFromResponsesResponse(payload.response);
        if (t) {
          sawAnyText = true;
          text += t;
        }
      }
      const calls = extractToolCallsFromResponsesResponse(payload.response);
      for (const c of calls) toolCalls.push(c);
    }
  }

  return { text, responseId, model, createdAt, toolCalls };
}

