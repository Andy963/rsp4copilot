# 重构笔记（rsp4copilot）

最后更新：2026-02-23

## 目标

- 改善结构、可扩展性、可维护性与性能。
- 保持行为稳定（不做有意的协议语义变更）。
- 保持 `npm run typecheck` 通过。

## 模块阅读状态

说明：
- `已精读`：逐段阅读过，可以安全做结构性调整。
- `已粗读`：快速扫过结构/味道，需要二次精读后再做有风险的改动。
- `未阅读`：尚未覆盖。

### 入口 / Worker

- `已精读` `src/workers.ts`：Worker 入口，委托到 `src/worker/handler.ts`。
- `已精读` `src/worker/handler.ts`：鉴权、路由、debug 日志、CORS。
- `已精读` `src/worker/utils.ts`：CORS、JSON body 解析、Copilot 相关注入逻辑。
- `已精读` `src/worker/types.ts`
- `已精读` `src/worker/routes/misc.ts`
- `已精读` `src/worker/routes/openai.ts`：OpenAI 路由（chat/completions/responses 等）。
- `已精读` `src/worker/routes/claude.ts`：Claude 路由（messages/count_tokens）。
- `已精读` `src/worker/routes/gemini.ts`：Gemini 路由（generateContent/streamGenerateContent）。

### 核心路由 / 配置

- `已精读` `src/config.ts`：配置解析/归一化（`RSP4COPILOT_CONFIG`）+ 上游 key 获取。
- `已精读` `src/model_resolver.ts`：`model` 解析（短名 vs `providerId.modelName` + provider hint）。
- `已精读` `src/models_list.ts`
- `已精读` `src/dispatch.ts`：OpenAI Chat 输入的 provider 分发。
- `已精读` `src/jsonc.ts`

### 协议转换

- `已精读` `src/protocols/responses.ts`
- `已精读` `src/protocols/stream/sse.ts`：SSE 编解码/解析工具。
- `已精读` `src/protocols/stream.ts`
- `已精读` `src/protocols/gemini.ts`
- `已精读` `src/protocols/stream/openai_chat_chunk.ts`
- `已精读` `src/protocols/stream/openai_chat_to_gemini.ts`
- `已精读` `src/protocols/stream/openai_chat_to_responses.ts`

### Providers

- `已精读` `src/providers/openai.ts`
- `已精读` `src/providers/openai/handle_request.ts`：Chat->Responses 的入口（`handleOpenAIRequest`）。
- `已精读` `src/providers/openai/handle_chat_completions.ts`
- `已精读` `src/providers/openai/handle_chat_completions_stream.ts`
- `已精读` `src/providers/openai/handle_text_completions.ts`
- `已精读` `src/providers/openai/params.ts`
- `已精读` `src/providers/openai/upstream_responses.ts`：Responses 上游直连 + thought signature 缓存。
- `已精读` `src/providers/openai/upstream_chat_completions.ts`
- `已精读` `src/providers/openai/upstream_select.ts`
- `已精读` `src/providers/openai/urls.ts`
- `已精读` `src/providers/openai/trim.ts`
- `已精读` `src/providers/openai/responses_extract.ts`
- `已精读` `src/providers/openai/responses_input.ts`
- `已精读` `src/providers/openai/responses_variants.ts`
- `已精读` `src/providers/openai/session_cache.ts`
- `已精读` `src/providers/openai/thought_signature_cache.ts`

- `已精读` `src/providers/claude.ts`
- `已精读` `src/providers/claude/convert.ts`：Claude URL 构造 + OpenAI<->Claude 转换 helper。
- `已精读` `src/providers/claude/handler.ts`
- `已精读` `src/providers/claude/model.ts`

- `已精读` `src/providers/gemini.ts`
- `已精读` `src/providers/gemini/chat_nonstream.ts`
- `已精读` `src/providers/gemini/chat_stream.ts`
- `已精读` `src/providers/gemini/contents.ts`
- `已精读` `src/providers/gemini/extract.ts`
- `已精读` `src/providers/gemini/handle_chat_completions.ts`
- `已精读` `src/providers/gemini/handle_generate_content_upstream.ts`
- `已精读` `src/providers/gemini/media.ts`
- `已精读` `src/providers/gemini/model.ts`
- `已精读` `src/providers/gemini/request.ts`
- `已精读` `src/providers/gemini/schema.ts`
- `已精读` `src/providers/gemini/thought_signature_cache.ts`
- `已精读` `src/providers/gemini/tools.ts`
- `已精读` `src/providers/gemini/urls.ts`

### Claude API 兼容层

- `已精读` `src/claude_api.ts`：Claude Messages 兼容、tokens 估算、流式转换。
- `已精读` `src/claude_api/openai_stream_to_messages_sse.ts`
- `已精读` `src/claude_api/openai_to_claude.ts`

### Common

- `已精读` `src/common.ts`：通用 helper + re-export；后续可以继续拆分收敛职责。
- `已精读` `src/common/limits.ts`
- `已精读` `src/common/openai_chat_messages.ts`
- `已精读` `src/common/types.ts`

## 已完成的重构（dev 分支）

- 在 `src/worker/utils.ts` 新增 `getProviderHintFromBody()`，并在 worker routes（`openai` / `claude`）统一使用，减少字段漂移风险。
- 在 `src/common.ts` 新增 `readFirstStringField()`，并用于 endpoint path 读取（`responsesPath` / `chatCompletionsPath` / `messagesPath`），减少重复代码与 `as any`。
- 在 `src/worker/handler.ts` 抽取 `extractInboundToken()`，并把 auth key 的查找从 `Array.includes()` 改为 `Set.has()`。
- 在 `src/worker/routes/openai.ts` 用 `buildOpenAIResponsesUpstreamEnv()` 去重 OpenAI Responses 上游 env 拼装逻辑。
- `src/models_list.ts`：把 `modelIdForList()` 的 O(n²) 计数改为预计算 `Map`（O(n)）。
- 统一 `src/providers/openai/handle_chat_completions_stream.ts` 的缩进（清理 tab），避免后续 diff 噪音。
- 修正 `src/providers/claude/handler.ts` 中 tool args delta 分支的缩进，提升可读性。

## 后续重构点（TODO）

### Worker 层

- 待路由形态稳定后，考虑把 `src/worker/handler.ts` 的分支路由改成 table-driven（降低扩展成本）。

### Providers / Protocols

- 若要进一步降低手写 SSE parsing 的重复度，可以评估把 `parseSseLines + buffer.lastIndexOf("\\n\\n")` 这类实现收敛到 `SseTextStreamParser`；但需要补充针对边界输入（多行 data、跨 chunk 边界、尾部无空行等）的验证。
