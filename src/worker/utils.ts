import { maskSecret, previewString } from "../common";

function mergeVary(existing: string, incoming: string): string {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    for (const part of String(value || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  };

  add(existing);
  add(incoming);
  return out.join(", ");
}

export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowOrigin = origin && typeof origin === "string" ? origin : "*";

  const reqHeaders = request.headers.get("access-control-request-headers") || "";
  const allowHeaders =
    typeof reqHeaders === "string" && reqHeaders.trim()
      ? reqHeaders
      : "authorization,content-type,x-session-id,x-api-key,x-goog-api-key,anthropic-api-key,x-anthropic-api-key,anthropic-version,anthropic-beta";

  const vary = typeof reqHeaders === "string" && reqHeaders.trim() ? "Origin, Access-Control-Request-Headers" : "Origin";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": allowHeaders,
    "access-control-max-age": "86400",
    vary,
  };
}

export function redactUrlSearchForLog(url: URL): string {
  const params = url?.searchParams;
  if (!params) return "";

  const isSensitiveKey = (keyLower: string) =>
    keyLower === "authorization" ||
    keyLower.includes("api_key") ||
    keyLower.endsWith("api-key") ||
    keyLower.endsWith("_key") ||
    keyLower.endsWith("key") ||
    keyLower.includes("token") ||
    keyLower.includes("password") ||
    keyLower.includes("passwd") ||
    keyLower.includes("secret");

  const out = new URLSearchParams();
  let count = 0;
  for (const [k, v] of params.entries()) {
    if (count++ >= 40) {
      out.append("__truncated__", "1");
      break;
    }
    const keyLower = String(k || "").toLowerCase();
    const safeVal = isSensitiveKey(keyLower) ? maskSecret(v) : previewString(v, 200);
    out.append(k, safeVal);
  }

  const s = out.toString();
  return s ? `?${s}` : "";
}

export function withCors(resp: Response, corsHeaders: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders || {})) {
    if (v == null) continue;
    if (k.toLowerCase() === "vary") {
      const existing = headers.get("vary") || "";
      headers.set("vary", existing ? mergeVary(existing, String(v)) : String(v));
      continue;
    }
    headers.set(k, String(v));
  }
  return new Response(resp.body, { status: resp.status || 200, headers });
}

export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; value: null }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, value: null };
  }
}

export function getProviderHintFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const obj: any = body;
  const raw = obj.provider ?? obj.owned_by ?? obj.ownedBy ?? obj.owner ?? obj.vendor;
  if (raw == null) return "";
  return typeof raw === "string" ? raw.trim() : String(raw).trim();
}

export function copilotToolUseInstructionsText(): string {
  return [
    "Tool use:",
    "- When tools are provided, use them to perform actions (file edits, patches, searches).",
    "- Do not say you will write/edit files and stop; call the relevant tool with valid JSON arguments.",
    "- Do not claim you changed files unless you actually called a tool and received a result.",
  ].join("\n");
}

export function shouldInjectCopilotToolUseInstructions(request: Request, reqJson: any): boolean {
  const ua = request.headers.get("user-agent") || "";
  if (typeof ua !== "string") return false;
  if (!ua.toLowerCase().includes("oai-compatible-copilot/")) return false;
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  return tools.length > 0;
}
