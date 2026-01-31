import {
  extractDeltaReasoningFromOpenAIChatChunk,
  extractDeltaTextFromOpenAIChatChunk,
  extractToolCallDeltasFromOpenAIChatChunk,
} from "./openai_chat_chunk";
import { encodeSse, parseSseLines } from "./sse";

export function openAIChatSseToResponsesSse(openAiResp: Response, modelId: string): ReadableStream<Uint8Array> | null {
  const src = openAiResp?.body;
  if (!src) return null;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const idSuffix = responseId.startsWith("resp_") ? responseId.slice("resp_".length) : responseId;
  const messageItemId = `msg_${idSuffix || crypto.randomUUID().replace(/-/g, "")}`;
  const reasoningItemId = `rs_${idSuffix || crypto.randomUUID().replace(/-/g, "")}`;

  let sequenceNumber = 0;
  const nextSeq = () => sequenceNumber++;

  let outputText = "";
  let reasoningTextSoFar = "";
  let sawAnyText = false;
  let sawAnyReasoning = false;
  let messageOutputIndex: number | null = null;
  let reasoningOutputIndex: number | null = null;
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
            sequence_number: nextSeq(),
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              model: modelId || "",
              status: "in_progress",
              output: [],
              output_text: "",
            },
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
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        item: { id: messageItemId, type: "message", role: "assistant", status: "in_progress", content: [] },
                      }),
                    ),
                  );
                }
                controller.enqueue(
                  encoder.encode(
                    encodeSse("response.output_text.delta", {
                      type: "response.output_text.delta",
                      sequence_number: nextSeq(),
                      output_index: messageOutputIndex,
                      item_id: messageItemId,
                      content_index: 0,
                      logprobs: [],
                      delta,
                    }),
                  ),
                );
              }

              // Reasoning/thinking deltas (e.g. `reasoning_content` from Chat Completions).
              const reasoningChunk = extractDeltaReasoningFromOpenAIChatChunk(obj);
              if (reasoningChunk) {
                let delta0 = "";
                if (reasoningChunk.startsWith(reasoningTextSoFar)) {
                  delta0 = reasoningChunk.slice(reasoningTextSoFar.length);
                  reasoningTextSoFar = reasoningChunk;
                } else if (reasoningTextSoFar.startsWith(reasoningChunk)) {
                  delta0 = "";
                } else {
                  delta0 = reasoningChunk;
                  reasoningTextSoFar += reasoningChunk;
                }

                if (reasoningTextSoFar) sawAnyReasoning = true;

                if (reasoningOutputIndex == null) {
                  reasoningOutputIndex = nextOutputIndex++;
                  controller.enqueue(
                    encoder.encode(
                      encodeSse("response.output_item.added", {
                        type: "response.output_item.added",
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item: {
                          id: reasoningItemId,
                          type: "reasoning",
                          status: "in_progress",
                          summary: [],
                          content: [],
                        },
                      }),
                    ),
                  );
                }

                if (delta0) {
                  controller.enqueue(
                    encoder.encode(
                      encodeSse("response.reasoning_text.delta", {
                        type: "response.reasoning_text.delta",
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item_id: reasoningItemId,
                        content_index: 0,
                        delta: delta0,
                      }),
                    ),
                  );
                }
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
                        sequence_number: nextSeq(),
                        output_index: toolCallIdToOutputIndex.get(callId),
                        item: {
                          id: `fc_${callId}`,
                          type: "function_call",
                          status: "in_progress",
                          call_id: callId,
                          name: td.name || "",
                          arguments: "",
                        },
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
                        sequence_number: nextSeq(),
                        output_index: toolCallIdToOutputIndex.get(callId),
                        item_id: `fc_${callId}`,
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
            controller.enqueue(
              encoder.encode(
                encodeSse("response.output_text.done", {
                  type: "response.output_text.done",
                  sequence_number: nextSeq(),
                  output_index: messageOutputIndex,
                  item_id: messageItemId,
                  content_index: 0,
                  logprobs: [],
                  text: outputText,
                }),
              ),
            );
          }
          if (sawAnyReasoning) {
            controller.enqueue(
              encoder.encode(
                encodeSse("response.reasoning_text.done", {
                  type: "response.reasoning_text.done",
                  sequence_number: nextSeq(),
                  output_index: reasoningOutputIndex,
                  item_id: reasoningItemId,
                  content_index: 0,
                  text: reasoningTextSoFar,
                }),
              ),
            );
          }

          for (const [callId, v] of toolCallsById.entries()) {
            const name = v?.name || "";
            const args = typeof v?.args === "string" ? v.args : "";
            controller.enqueue(
              encoder.encode(
                encodeSse("response.function_call_arguments.done", {
                  type: "response.function_call_arguments.done",
                  sequence_number: nextSeq(),
                  output_index: toolCallIdToOutputIndex.get(callId),
                  item_id: `fc_${callId}`,
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
                  sequence_number: nextSeq(),
                  output_index: toolCallIdToOutputIndex.get(callId) ?? null,
                  item: {
                    id: `fc_${callId}`,
                    type: "function_call",
                    status: "completed",
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
              item: {
                id: messageItemId,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: outputText }],
              },
            });
          } else if (!toolCallsById.size) {
            // Preserve the previous behavior: always return at least one message item.
            const idx0 = nextOutputIndex++;
            output.push({
              output_index: idx0,
              item: {
                id: messageItemId,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "" }],
              },
            });
          }
          if (sawAnyReasoning) {
            output.push({
              output_index: reasoningOutputIndex ?? nextOutputIndex++,
              item: {
                id: reasoningItemId,
                type: "reasoning",
                status: "completed",
                summary: [{ type: "summary_text", text: reasoningTextSoFar }],
                content: [{ type: "reasoning_text", text: reasoningTextSoFar }],
              },
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
                status: "completed",
                call_id: callId,
                ...(name ? { name } : {}),
                arguments: args,
                ...(v?.thoughtSignature ? { thought_signature: v.thoughtSignature } : {}),
                ...(typeof v?.thought === "string" ? { thought: v.thought } : {}),
              },
            });
          }
          output.sort((a, b) => a.output_index - b.output_index);

          if (messageOutputIndex != null) {
            controller.enqueue(
              encoder.encode(
                encodeSse("response.output_item.done", {
                  type: "response.output_item.done",
                  sequence_number: nextSeq(),
                  output_index: messageOutputIndex,
                  item: output.find((o) => o.output_index === messageOutputIndex)?.item ?? null,
                }),
              ),
            );
          }
          if (sawAnyReasoning && reasoningOutputIndex != null) {
            controller.enqueue(
              encoder.encode(
                encodeSse("response.output_item.done", {
                  type: "response.output_item.done",
                  sequence_number: nextSeq(),
                  output_index: reasoningOutputIndex,
                  item: output.find((o) => o.output_index === reasoningOutputIndex)?.item ?? null,
                }),
              ),
            );
          }

          controller.enqueue(
            encoder.encode(
              encodeSse("response.completed", {
                type: "response.completed",
                sequence_number: nextSeq(),
                response: {
                  id: responseId,
                  object: "response",
                  created_at: createdAt,
                  model: modelId || "",
                  status: "completed",
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

