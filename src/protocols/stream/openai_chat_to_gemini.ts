import { extractDeltaTextFromOpenAIChatChunk } from "./openai_chat_chunk";
import { encodeSse, parseSseLines } from "./sse";

export function openAIChatSseToGeminiSse(openAiResp: Response): ReadableStream<Uint8Array> | null {
  const src = openAiResp?.body;
  if (!src) return null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = src.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const idx = buffer.lastIndexOf("\n\n");
          if (idx < 0) continue;
          const chunkText = buffer.slice(0, idx + 2);
          buffer = buffer.slice(idx + 2);

          for (const evt of parseSseLines(chunkText)) {
            const data = evt.data;
            if (data === "[DONE]") continue;
            let obj: unknown;
            try {
              obj = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = extractDeltaTextFromOpenAIChatChunk(obj);
            if (!delta) continue;
            const gem = {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: delta }] },
                  index: 0,
                },
              ],
            };
            controller.enqueue(encoder.encode(encodeSse("", gem)));
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

