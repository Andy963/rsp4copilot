function encodeSse(event: string, dataObj: unknown): string {
  const data = typeof dataObj === "string" ? dataObj : JSON.stringify(dataObj);
  return event ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}

function parseSseLines(text: string): Array<{ event: string; data: string }> {
  const lines = String(text || "").split(/\r?\n/);
  const out: Array<{ event: string; data: string }> = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = () => {
    if (!event && !dataLines.length) return;
    const data = dataLines.join("\n");
    out.push({ event: event || "message", data });
    event = "";
    dataLines = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }
  flush();
  return out;
}

function extractDeltaTextFromOpenAIChatChunk(obj: unknown): string {
  const chunkObj = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const choices = Array.isArray((chunkObj as any).choices) ? ((chunkObj as any).choices as unknown[]) : [];
  const c0 = choices.length ? (choices[0] as any) : null;
  const delta = c0 && typeof c0.delta === "object" ? (c0.delta as any) : null;
  if (delta && typeof delta.content === "string") return delta.content;
  return "";
}

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

export function openAIChatSseToResponsesSse(openAiResp: Response, modelId: string): ReadableStream<Uint8Array> | null {
  const src = openAiResp?.body;
  if (!src) return null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const responseId = `resp_${Date.now().toString(36)}`;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeSse("response.created", {
            type: "response.created",
            response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: modelId || "" },
          }),
        ),
      );
      (async () => {
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
              controller.enqueue(
                encoder.encode(
                  encodeSse("response.output_text.delta", {
                    type: "response.output_text.delta",
                    delta,
                  }),
                ),
              );
            }
          }
        } finally {
          reader.releaseLock();
          controller.enqueue(encoder.encode(encodeSse("response.completed", { type: "response.completed", response: { id: responseId } })));
          controller.close();
        }
      })();
    },
  });
}

