import { sha256Hex } from "../../common";

async function thoughtSignatureCacheUrl(sessionKey: string): Promise<string> {
  const hex = await sha256Hex(`thought_sig_${sessionKey}`);
  return `https://thought-sig.rsp2com/${hex}`;
}

export async function getThoughtSignatureCache(sessionKey: string): Promise<Record<string, any>> {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return {};
    const url = await thoughtSignatureCacheUrl(sessionKey);
    const resp = await cache.match(url);
    if (!resp) return {};
    const data = await resp.json().catch(() => null);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function setThoughtSignatureCache(
  sessionKey: string,
  callId: string,
  thoughtSignature: string,
  thought: string,
  name: string,
): Promise<void> {
  try {
    const cache = !sessionKey || !callId || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return;
    // Get existing cache
    const existing: any = await getThoughtSignatureCache(sessionKey);
    // Add new entry
    existing[callId] = {
      thought_signature: thoughtSignature || "",
      thought: thought || "",
      name: name || "",
      updated_at: Date.now(),
    };
    // Limit cache size (keep last 100 entries)
    const entries: any[] = Object.entries(existing);
    if (entries.length > 100) {
      entries.sort((a, b) => ((b?.[1]?.updated_at as any) || 0) - ((a?.[1]?.updated_at as any) || 0));
      const kept = Object.fromEntries(entries.slice(0, 100));
      Object.keys(existing).forEach((k) => {
        if (!(k in kept)) delete existing[k];
      });
    }
    const url = await thoughtSignatureCacheUrl(sessionKey);
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

