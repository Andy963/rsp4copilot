function bytesToBase64(bytes: Uint8Array): string {
  if (!bytes) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function parseDataUrl(dataUrl: unknown): { mimeType: string; data: string } | null {
  const s = typeof dataUrl === "string" ? dataUrl.trim() : "";
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const meta = s.slice(5, comma);
  const data = s.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  const mimeType = meta.replace(/;base64/i, "").trim() || "application/octet-stream";
  if (!isBase64) return null;
  return { mimeType, data: data.replace(/\s+/g, "") };
}

function guessMimeTypeFromUrl(url: unknown): string {
  const s = typeof url === "string" ? url.toLowerCase() : "";
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  return "";
}

async function openaiImageToGeminiPart(imageValue: unknown, mimeTypeHint: unknown, fetchFn: typeof fetch): Promise<any | null> {
  const v0 = typeof imageValue === "string" ? imageValue.trim() : "";
  if (!v0) return null;

  const parsed = parseDataUrl(v0);
  if (parsed) {
    return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } };
  }

  const isHttp = /^https?:\/\//i.test(v0);
  const mimeType = (typeof mimeTypeHint === "string" && mimeTypeHint.trim()) || guessMimeTypeFromUrl(v0) || "image/png";

  // Pure base64 (no data: prefix)
  if (!isHttp) {
    const cleaned = v0.replace(/\s+/g, "");
    return { inlineData: { mimeType, data: cleaned } };
  }

  // Fetch remote image and inline it (Gemini API does not accept arbitrary http(s) URLs as image parts).
  const resp = await fetchFn(v0);
  if (!resp.ok) return null;
  const ct = resp.headers.get("content-type") || "";
  const mt = ct.split(";")[0].trim() || mimeType;
  const ab = await resp.arrayBuffer();
  const bytes = new Uint8Array(ab);
  // 8 MiB guardrail
  if (bytes.byteLength > 8 * 1024 * 1024) return null;
  const b64 = bytesToBase64(bytes);
  return { inlineData: { mimeType: mt, data: b64 } };
}

export async function openaiContentToGeminiParts(content: unknown, fetchFn: typeof fetch): Promise<any[]> {
  const parts: any[] = [];
  const pushText = (text: unknown) => {
    if (typeof text !== "string") return;
    const t = text;
    if (!t || !t.trim()) return;
    parts.push({ text: t });
  };

  const handlePart = async (part: any) => {
    if (part == null) return;
    if (typeof part === "string") {
      pushText(part);
      return;
    }
    if (typeof part !== "object") {
      pushText(String(part));
      return;
    }

    const t = part.type;
    if (t === "text" && typeof part.text === "string") {
      pushText(part.text);
      return;
    }
    if (t === "image_url" || t === "input_image" || t === "image") {
      const mimeType = part.mime_type || part.mimeType || part.media_type || part.mediaType || "";
      const v = part.image_url ?? part.url ?? part.image;
      if (typeof v === "string") {
        const img = await openaiImageToGeminiPart(v, mimeType, fetchFn);
        if (img) parts.push(img);
      } else if (v && typeof v === "object") {
        const url = v.url ?? v.image_url ?? v.image;
        const b64 = v.base64 ?? v.b64 ?? v.b64_json ?? v.data ?? v.image_base64 ?? v.imageBase64;
        if (typeof url === "string") {
          const img = await openaiImageToGeminiPart(url, mimeType, fetchFn);
          if (img) parts.push(img);
        } else if (typeof b64 === "string") {
          const img = await openaiImageToGeminiPart(b64, mimeType, fetchFn);
          if (img) parts.push(img);
        }
      }
      return;
    }

    if (typeof part.text === "string") {
      pushText(part.text);
      return;
    }
  };

  if (Array.isArray(content)) {
    for (const item of content) await handlePart(item);
    return parts;
  }
  await handlePart(content);
  return parts;
}

