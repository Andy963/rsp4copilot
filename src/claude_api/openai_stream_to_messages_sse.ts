import { jsonError, logDebug, sseHeaders } from "../common";
import { openaiFinishReasonToClaude } from "./openai_to_claude";

function encodeSseEvent(event: string, dataStr: string): string {
  return `event: ${event}\ndata: ${dataStr}\n\n`;
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

function extractOpenaiDeltaText(chunkObj: any): string {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? c0.delta : null;
  const content = delta?.content;
  return typeof content === "string" ? content : "";
}

function extractOpenaiFinishReason(chunkObj: any): string {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const fr = c0 && typeof c0.finish_reason === "string" ? c0.finish_reason : "";
  return fr;
}

function extractOpenaiToolCallDeltas(chunkObj: any): Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> {
  const choices = Array.isArray(chunkObj?.choices) ? chunkObj.choices : [];
  const c0 = choices.length ? choices[0] : null;
  const delta = c0 && typeof c0.delta === "object" ? c0.delta : null;
  const toolCalls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];

  const out: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const idx = Number.isInteger((tc as any).index) ? (tc as any).index : 0;
    const id = typeof (tc as any).id === "string" && String((tc as any).id).trim() ? String((tc as any).id).trim() : undefined;
    const fn = (tc as any).function && typeof (tc as any).function === "object" ? (tc as any).function : null;
    const name = fn && typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : undefined;
    const argsDelta = fn && typeof fn.arguments === "string" && fn.arguments ? fn.arguments : undefined;
    out.push({
      index: idx,
      ...(id ? { id } : null),
      ...(name ? { name } : null),
      ...(argsDelta ? { argumentsDelta: argsDelta } : null),
    });
  }
  return out;
}

export async function openaiStreamToClaudeMessagesSse(openAiResp: Response, opts: { reqModel: string; debug: boolean; reqId: string }): Promise<any> {
  const src = openAiResp?.body;
  if (!src) return { ok: false, status: 502, error: jsonError("Missing upstream body", "bad_gateway") };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const createdAt = Math.floor(Date.now() / 1000);
  const msgId = `msg_${Date.now().toString(36)}`;

  // Initial message event (Claude SSE usually starts with message_start)
  const startEvt = encodeSseEvent(
    "message_start",
    JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: opts.reqModel || "",
        content: [],
        stop_reason: null,
      },
    }),
  );
  await writer.write(encoder.encode(startEvt));

  (async () => {
    const reader = src.getReader();
    type ToolBlockState = {
      key: string;
      blockIndex: number;
      id: string;
      name: string;
      argsBuffer: string;
      started: boolean;
    };

    let stop_reason = "end_turn";
    let sawDone = false;

    let nextBlockIndex = 0;
    let textBlockIndex: number | null = null;
    const toolBlocks = new Map<string, ToolBlockState>();
    const startedBlockIndexes: number[] = [];
    const startedBlockSet = new Set<number>();
    const stoppedBlockSet = new Set<number>();

    const emitEvent = async (eventName: string, payload: unknown) => {
      const evt = encodeSseEvent(eventName, JSON.stringify(payload));
      await writer.write(encoder.encode(evt));
    };

    const startBlock = async (index: number, content_block: unknown) => {
      if (startedBlockSet.has(index)) return;
      startedBlockSet.add(index);
      startedBlockIndexes.push(index);
      await emitEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block,
      });
    };

    const stopBlock = async (index: number) => {
      if (stoppedBlockSet.has(index)) return;
      stoppedBlockSet.add(index);
      await emitEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      });
    };

    const ensureTextBlockStarted = async () => {
      if (textBlockIndex != null) return textBlockIndex;
      textBlockIndex = nextBlockIndex++;
      await startBlock(textBlockIndex, { type: "text", text: "" });
      return textBlockIndex;
    };

    const toolKeyFromDelta = (tc: { index: number; id?: string }) => {
      const id = typeof tc.id === "string" ? tc.id.trim() : "";
      if (id) return `id:${id}`;
      return `idx:${tc.index}`;
    };

    const ensureToolBlockStarted = async (st: ToolBlockState) => {
      if (st.started) return;
      const toolName = st.name || "unknown_tool";
      await startBlock(st.blockIndex, { type: "tool_use", id: st.id, name: toolName, input: {} });
      st.started = true;
      if (st.argsBuffer) {
        await emitEvent("content_block_delta", {
          type: "content_block_delta",
          index: st.blockIndex,
          delta: { type: "input_json_delta", partial_json: st.argsBuffer },
        });
        st.argsBuffer = "";
      }
    };

    const processChunkText = async (chunkText: string) => {
      for (const evt0 of parseSseLines(chunkText)) {
        const data = evt0.data;
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let obj: any;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }

        const fr = extractOpenaiFinishReason(obj);
        if (fr) stop_reason = openaiFinishReasonToClaude(fr);

        const deltaText = extractOpenaiDeltaText(obj);
        if (deltaText) {
          const idx2 = await ensureTextBlockStarted();
          await emitEvent("content_block_delta", {
            type: "content_block_delta",
            index: idx2,
            delta: { type: "text_delta", text: deltaText },
          });
        }

        const tcs = extractOpenaiToolCallDeltas(obj);
        for (const tc of tcs) {
          const key = toolKeyFromDelta(tc);
          let st = toolBlocks.get(key);
          if (!st) {
            st = {
              key,
              blockIndex: nextBlockIndex++,
              id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
              name: tc.name || "",
              argsBuffer: "",
              started: false,
            };
            toolBlocks.set(key, st);
          }

          if (!st.started && tc.id && tc.id.trim()) st.id = tc.id.trim();
          if (!st.name && tc.name) st.name = tc.name;

          if (!st.started && st.name) {
            await ensureToolBlockStarted(st);
          }

          if (typeof tc.argumentsDelta === "string" && tc.argumentsDelta) {
            if (st.started) {
              await emitEvent("content_block_delta", {
                type: "content_block_delta",
                index: st.blockIndex,
                delta: { type: "input_json_delta", partial_json: tc.argumentsDelta },
              });
            } else {
              st.argsBuffer += tc.argumentsDelta;
            }
          }
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const idxLf = buffer.lastIndexOf("\n\n");
        const idxCrLf = buffer.lastIndexOf("\r\n\r\n");
        const idx = idxCrLf > idxLf ? idxCrLf : idxLf;
        const delimLen = idxCrLf > idxLf ? 4 : 2;
        if (idx < 0) continue;

        const chunkText = buffer.slice(0, idx + delimLen);
        buffer = buffer.slice(idx + delimLen);

        await processChunkText(chunkText);
        if (sawDone) break;
      }

      // If the upstream ended without a trailing blank line, process any remaining buffered data.
      buffer += decoder.decode();
      if (!sawDone && buffer.trim()) {
        await processChunkText(buffer);
      }
    } catch (err) {
      if (opts.debug) {
        const msg = err instanceof Error ? err.message : String(err ?? "stream error");
        logDebug(opts.debug, opts.reqId, "openai->claude stream error", { error: msg });
      }
    } finally {
      try {
        await reader.releaseLock();
      } catch {}

      try {
        await reader.cancel();
      } catch {}

      // Start any tool blocks that never got a name, so we don't drop buffered args.
      for (const st of toolBlocks.values()) {
        if (!st.started && (st.name || st.argsBuffer)) {
          await ensureToolBlockStarted(st);
        }
      }

      // Close any started blocks.
      for (const idx2 of startedBlockIndexes) {
        await stopBlock(idx2);
      }

      // message_delta
      await emitEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason,
          stop_sequence: null,
        },
      });

      // message_stop
      await emitEvent("message_stop", {
        type: "message_stop",
        message: { id: msgId },
      });

      try {
        await writer.close();
      } catch {}
    }
  })();

  return { ok: true, resp: new Response(readable, { status: 200, headers: sseHeaders() }) };
}
