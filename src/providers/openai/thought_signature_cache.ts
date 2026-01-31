import { sha256Hex } from "../../common";

export function normalizeResponsesCallId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return "";
  // Some clients echo Responses output items back as input with `id:"fc_<callId>"` but without `call_id`.
  if (id.startsWith("fc_") && id.length > 3) return id.slice(3);
  return id;
}

async function responsesThoughtSignatureCacheUrl(sessionKey: string): Promise<string> {
  const hex = await sha256Hex(`resp_thought_sig_${sessionKey}`);
  return `https://thought-sig.rsp2com/${hex}`;
}

export async function getResponsesThoughtSignatureCache(sessionKey: string): Promise<Record<string, unknown>> {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return {};
    const url = await responsesThoughtSignatureCacheUrl(sessionKey);
    const resp = await cache.match(url);
    if (!resp) return {};
    const data = await resp.json().catch(() => null);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export async function setResponsesThoughtSignatureCache(sessionKey: string, updates: any): Promise<void> {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return;
    const up = updates && typeof updates === "object" && !Array.isArray(updates) ? updates : {};
    const keys = Object.keys(up);
    if (!keys.length) return;

    const existing: any = await getResponsesThoughtSignatureCache(sessionKey);
    for (const callIdRaw of keys) {
      const callId = normalizeResponsesCallId(callIdRaw);
      if (!callId) continue;
      const u = up[callIdRaw];
      if (!u || typeof u !== "object") continue;
      const ts = typeof u.thought_signature === "string" ? u.thought_signature : typeof u.thoughtSignature === "string" ? u.thoughtSignature : "";
      const thought = typeof u.thought === "string" ? u.thought : "";
      const name = typeof u.name === "string" ? u.name : "";
      if (!ts || !String(ts).trim()) continue;
      existing[callId] = {
        thought_signature: String(ts).trim(),
        thought: thought || (existing[callId] && typeof existing[callId].thought === "string" ? existing[callId].thought : "") || "",
        name: name || (existing[callId] && typeof existing[callId].name === "string" ? existing[callId].name : "") || "",
        updated_at: Date.now(),
      };
    }

    // Keep cache bounded.
    const entries: any[] = Object.entries(existing);
    if (entries.length > 200) {
      entries.sort((a, b) => ((b?.[1]?.updated_at as any) || 0) - ((a?.[1]?.updated_at as any) || 0));
      const kept = Object.fromEntries(entries.slice(0, 200));
      for (const k of Object.keys(existing)) {
        if (!(k in kept)) delete existing[k];
      }
    }

    const url = await responsesThoughtSignatureCacheUrl(sessionKey);
    const req = new Request(url, { method: "GET" });
    const resp = new Response(JSON.stringify(existing), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "max-age=86400",
      },
    });
    await cache.put(req, resp);
  } catch {
    // ignore
  }
}

export function applyCachedThoughtSignaturesToResponsesRequest(req: any, sigCache: any): { filled: number; dropped: number; missing: number } {
  const cache = sigCache && typeof sigCache === "object" && !Array.isArray(sigCache) ? sigCache : {};
  if (!req || typeof req !== "object") return { filled: 0, dropped: 0, missing: 0 };
  if (!Array.isArray(req.input)) return { filled: 0, dropped: 0, missing: 0 };

  const input = req.input as any[];
  const callIdsWithOutput = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call_output") continue;
    const callId = normalizeResponsesCallId(item.call_id ?? item.callId ?? item.id);
    if (callId) callIdsWithOutput.add(callId);
  }

  const hasPrev =
    (typeof req.previous_response_id === "string" && req.previous_response_id.trim()) ||
    (typeof req.conversation === "string" && req.conversation.trim()) ||
    false;

  let filled = 0;
  let dropped = 0;
  let missing = 0;
  const nextInput: any[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") {
      nextInput.push(item);
      continue;
    }
    if (item.type !== "function_call") {
      nextInput.push(item);
      continue;
    }

    const callId = normalizeResponsesCallId(item.call_id ?? item.callId ?? item.id);
    if (!callId) {
      nextInput.push(item);
      continue;
    }

    const existingSig = item.thought_signature ?? item.thoughtSignature;
    if (typeof existingSig === "string" && existingSig.trim()) {
      nextInput.push(item);
      continue;
    }

    const cached = (cache as any)[callId];
    const cachedSig = cached?.thought_signature ?? cached?.thoughtSignature;
    if (typeof cachedSig === "string" && cachedSig.trim()) {
      item.thought_signature = cachedSig.trim();
      const existingThought = item.thought;
      if (!(typeof existingThought === "string" && existingThought)) {
        const cachedThought = cached?.thought;
        if (typeof cachedThought === "string") item.thought = cachedThought;
      }
      filled++;
      nextInput.push(item);
      continue;
    }

    // Some gateways require thought_signature on function_call inputs; if we can't provide it but we do
    // have the corresponding tool output, drop the function_call item to keep the request valid.
    // Only do this when the request is anchored by previous_response_id/conversation; otherwise we'd
    // strand a function_call_output with no matching function_call, which upstream rejects.
    if (hasPrev && callIdsWithOutput.has(callId)) {
      dropped++;
      continue;
    }

    missing++;
    nextInput.push(item);
  }

  if (dropped > 0) req.input = nextInput;
  return { filled, dropped, missing };
}

