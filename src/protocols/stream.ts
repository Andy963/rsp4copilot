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

function extractToolCallDeltasFromOpenAIChatChunk(
  obj: unknown,
): Array<{ index: number; id?: string; name?: string; argumentsDelta?: string; thoughtSignature?: string; thought?: string }> {
  const chunkObj = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const choices = Array.isArray((chunkObj as any).choices) ? ((chunkObj as any).choices as any[]) : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? (c0.delta as any) : null;
  const toolCalls = delta && Array.isArray(delta.tool_calls) ? (delta.tool_calls as any[]) : [];
  const out: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string; thoughtSignature?: string; thought?: string }> = [];

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const index = Number.isInteger((tc as any).index) ? (tc as any).index : 0;
    const id = typeof (tc as any).id === "string" && (tc as any).id.trim() ? (tc as any).id.trim() : undefined;
    const fn = (tc as any).function && typeof (tc as any).function === "object" ? (tc as any).function : null;
    const name = fn && typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : undefined;
    const argumentsDelta = fn && typeof fn.arguments === "string" && fn.arguments ? fn.arguments : undefined;
    const thoughtSignature =
      (tc as any).thought_signature ??
      (tc as any).thoughtSignature ??
      (fn ? (fn as any).thought_signature ?? (fn as any).thoughtSignature : undefined);
    const thought = (tc as any).thought ?? (tc as any).reasoning ?? (fn ? (fn as any).thought ?? (fn as any).reasoning : undefined);

    out.push({
      index,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(argumentsDelta ? { argumentsDelta } : {}),
      ...(typeof thoughtSignature === "string" && thoughtSignature.trim() ? { thoughtSignature: thoughtSignature.trim() } : {}),
      ...(typeof thought === "string" ? { thought } : {}),
    });
  }

  return out;
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
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let outputText = "";
  let sawAnyText = false;
  let messageOutputIndex: number | null = null;
  const toolIndexToCallId = new Map<number, string>();
  const toolCallIdToOutputIndex = new Map<string, number>();
  const toolCallsById = new Map<string, { name: string; args: string; thoughtSignature?: string; thought?: string }>();
  let nextOutputIndex = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeSse("response.created", {
            type: "response.created",
            response: { id: responseId, object: "response", created_at: createdAt, model: modelId || "" },
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

              // Text deltas
              const delta = extractDeltaTextFromOpenAIChatChunk(obj);
              if (delta) {
                outputText += delta;
                sawAnyText = true;
                if (messageOutputIndex == null) {
                  messageOutputIndex = nextOutputIndex++;
                  controller.enqueue(
                    encoder.encode(
                      encodeSse("response.output_item.added", {
                        type: "response.output_item.added",
                        output_index: messageOutputIndex,
                        item: { id: `msg_${responseId}`, type: "message", role: "assistant", content: [] },
                      }),
                    ),
                  );
                }
                controller.enqueue(
                  encoder.encode(
                    encodeSse("response.output_text.delta", {
                      type: "response.output_text.delta",
                      delta,
                    }),
                  ),
                );
              }

              // Tool call deltas
              const toolDeltas = extractToolCallDeltasFromOpenAIChatChunk(obj);
              for (const td of toolDeltas) {
                const idx0 = Number.isInteger(td.index) ? td.index : 0;
                const callId =
                  typeof td.id === "string" && td.id.trim()
                    ? td.id.trim()
                    : toolIndexToCallId.get(idx0) || `call_${responseId}_${idx0.toString(36)}`;
                toolIndexToCallId.set(idx0, callId);

                if (!toolCallIdToOutputIndex.has(callId)) {
                  toolCallIdToOutputIndex.set(callId, nextOutputIndex++);
                  controller.enqueue(
                    encoder.encode(
                      encodeSse("response.output_item.added", {
                        type: "response.output_item.added",
                        output_index: toolCallIdToOutputIndex.get(callId),
                        item: { id: `fc_${callId}`, type: "function_call", call_id: callId, name: td.name || "", arguments: "" },
                      }),
                    ),
                  );
                }

                const buf0 = toolCallsById.get(callId) || { name: "", args: "" };
                if (typeof td.name === "string" && td.name.trim()) buf0.name = td.name.trim();
                if (typeof td.thoughtSignature === "string" && td.thoughtSignature.trim()) buf0.thoughtSignature = td.thoughtSignature.trim();
                if (typeof td.thought === "string") buf0.thought = td.thought;

                const argsDelta = typeof td.argumentsDelta === "string" ? td.argumentsDelta : "";
                if (argsDelta) buf0.args += argsDelta;
                toolCallsById.set(callId, buf0);

                if (argsDelta) {
                  controller.enqueue(
                    encoder.encode(
                      encodeSse("response.function_call_arguments.delta", {
                        type: "response.function_call_arguments.delta",
                        call_id: callId,
                        ...(buf0.name ? { name: buf0.name } : {}),
                        ...(buf0.thoughtSignature ? { thought_signature: buf0.thoughtSignature } : {}),
                        ...(typeof buf0.thought === "string" ? { thought: buf0.thought } : {}),
                        delta: argsDelta,
                      }),
                    ),
                  );
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
          if (sawAnyText) {
            controller.enqueue(encoder.encode(encodeSse("response.output_text.done", { type: "response.output_text.done", text: outputText })));
          }

          for (const [callId, v] of toolCallsById.entries()) {
            const name = v?.name || "";
            const args = typeof v?.args === "string" ? v.args : "";
            controller.enqueue(
              encoder.encode(
                encodeSse("response.function_call_arguments.done", {
                  type: "response.function_call_arguments.done",
                  call_id: callId,
                  ...(name ? { name } : {}),
                  ...(v?.thoughtSignature ? { thought_signature: v.thoughtSignature } : {}),
                  ...(typeof v?.thought === "string" ? { thought: v.thought } : {}),
                  arguments: args,
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(
                encodeSse("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index: toolCallIdToOutputIndex.get(callId) ?? null,
                  item: {
                    id: `fc_${callId}`,
                    type: "function_call",
                    call_id: callId,
                    ...(name ? { name } : {}),
                    arguments: args,
                    ...(v?.thoughtSignature ? { thought_signature: v.thoughtSignature } : {}),
                    ...(typeof v?.thought === "string" ? { thought: v.thought } : {}),
                  },
                }),
              ),
            );
          }

          const output: Array<{ output_index: number; item: any }> = [];
          if (messageOutputIndex != null) {
            output.push({
              output_index: messageOutputIndex,
              item: { id: `msg_${responseId}`, type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] },
            });
          } else if (!toolCallsById.size) {
            // Preserve the previous behavior: always return at least one message item.
            output.push({
              output_index: 0,
              item: { id: `msg_${responseId}`, type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
            });
          }
          for (const [callId, v] of toolCallsById.entries()) {
            const idx0 = toolCallIdToOutputIndex.get(callId) ?? output.length;
            const name = v?.name || "";
            const args = typeof v?.args === "string" ? v.args : "";
            output.push({
              output_index: idx0,
              item: {
                id: `fc_${callId}`,
                type: "function_call",
                call_id: callId,
                ...(name ? { name } : {}),
                arguments: args,
                ...(v?.thoughtSignature ? { thought_signature: v.thoughtSignature } : {}),
                ...(typeof v?.thought === "string" ? { thought: v.thought } : {}),
              },
            });
          }
          output.sort((a, b) => a.output_index - b.output_index);

          controller.enqueue(
            encoder.encode(
              encodeSse("response.completed", {
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  created_at: createdAt,
                  model: modelId || "",
                  output_text: outputText,
                  output: output.map((o) => o.item),
                },
              }),
            ),
          );
          controller.enqueue(encoder.encode(encodeSse("", "[DONE]")));
          controller.close();
        }
      })();
    },
  });
}
