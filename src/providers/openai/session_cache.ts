import { sha256Hex } from "../../common";

async function sessionCacheUrl(sessionKey: string): Promise<string> {
  const hex = await sha256Hex(sessionKey);
  return `https://session.rsp2com/${hex}`;
}

export async function getSessionPreviousResponseId(sessionKey: string): Promise<string | null> {
  try {
    const cache = !sessionKey || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return null;
    const url = await sessionCacheUrl(sessionKey);
    const resp = await cache.match(url);
    if (!resp) return null;
    const data = await resp.json().catch(() => null);
    const rid = data?.previous_response_id;
    return typeof rid === "string" && rid ? rid : null;
  } catch {
    return null;
  }
}

export async function setSessionPreviousResponseId(sessionKey: string, responseId: string): Promise<void> {
  try {
    const cache = !sessionKey || !responseId || typeof caches === "undefined" ? null : ((caches as any).default ?? null);
    if (!cache) return;
    const url = await sessionCacheUrl(sessionKey);
    const req = new Request(url, { method: "GET" });
    const resp = new Response(JSON.stringify({ previous_response_id: responseId, updated_at: Date.now() }), {
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

