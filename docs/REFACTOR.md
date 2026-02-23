# Refactor Notes (rsp4copilot)

Last updated: 2026-02-23

## Goals

- Improve structure, extensibility, maintainability, and performance.
- Keep behavior stable (no intentional protocol changes).
- Keep `npm run typecheck` passing.

## Module Review Status

Legend:
- `Reviewed`: read in detail (safe to refactor).
- `Skimmed`: scanned for shape/smells (needs deeper pass before risky changes).
- `Pending`: not reviewed yet.

### Entry / Worker

- `Reviewed` `src/workers.ts`: Worker entrypoint delegates to `src/worker/handler.ts`.
- `Reviewed` `src/worker/handler.ts`: auth, routing, debug logging, CORS wiring.
- `Reviewed` `src/worker/utils.ts`: CORS helpers, JSON body parsing, Copilot-specific instructions injection.
- `Pending` `src/worker/types.ts`
- `Pending` `src/worker/routes/misc.ts`
- `Reviewed` `src/worker/routes/openai.ts`: OpenAI routes (chat/completions/responses/models wiring).
- `Reviewed` `src/worker/routes/claude.ts`: Claude routes (messages/count_tokens wiring).
- `Reviewed` `src/worker/routes/gemini.ts`: Gemini routes (generateContent/streamGenerateContent wiring).

### Core Routing / Config

- `Reviewed` `src/config.ts`: config parsing/normalization (`RSP4COPILOT_CONFIG`) + api key lookup.
- `Reviewed` `src/model_resolver.ts`: `model` resolution (short id vs `providerId.modelName`, provider hint).
- `Pending` `src/models_list.ts`
- `Reviewed` `src/dispatch.ts`: provider dispatch for OpenAI Chat inputs.
- `Pending` `src/jsonc.ts`

### Protocol Conversions

- `Pending` `src/protocols/responses.ts`
- `Reviewed` `src/protocols/stream/sse.ts`: SSE encoding/parsing utilities.
- `Pending` `src/protocols/stream.ts`
- `Pending` `src/protocols/gemini.ts`
- `Pending` `src/protocols/stream/openai_chat_chunk.ts`
- `Pending` `src/protocols/stream/openai_chat_to_gemini.ts`
- `Pending` `src/protocols/stream/openai_chat_to_responses.ts`

### Providers

- `Pending` `src/providers/openai.ts`
- `Skimmed` `src/providers/openai/handle_request.ts`: entry for Chat->Responses path.
- `Pending` `src/providers/openai/handle_chat_completions.ts`
- `Pending` `src/providers/openai/handle_chat_completions_stream.ts`
- `Pending` `src/providers/openai/handle_text_completions.ts`
- `Pending` `src/providers/openai/params.ts`
- `Skimmed` `src/providers/openai/upstream_responses.ts`: proxy OpenAI Responses upstream, cache thought signatures.
- `Pending` `src/providers/openai/upstream_chat_completions.ts`
- `Pending` `src/providers/openai/upstream_select.ts`
- `Pending` `src/providers/openai/urls.ts`
- `Pending` `src/providers/openai/trim.ts`
- `Pending` `src/providers/openai/responses_extract.ts`
- `Pending` `src/providers/openai/responses_input.ts`
- `Pending` `src/providers/openai/responses_variants.ts`
- `Pending` `src/providers/openai/session_cache.ts`
- `Pending` `src/providers/openai/thought_signature_cache.ts`

- `Pending` `src/providers/claude.ts`
- `Reviewed` `src/providers/claude/convert.ts`: build Claude URLs + OpenAI<->Claude conversion helpers.
- `Pending` `src/providers/claude/handler.ts`
- `Pending` `src/providers/claude/model.ts`

- `Pending` `src/providers/gemini.ts`
- `Pending` `src/providers/gemini/chat_nonstream.ts`
- `Pending` `src/providers/gemini/chat_stream.ts`
- `Pending` `src/providers/gemini/contents.ts`
- `Pending` `src/providers/gemini/extract.ts`
- `Pending` `src/providers/gemini/handle_chat_completions.ts`
- `Pending` `src/providers/gemini/handle_generate_content_upstream.ts`
- `Pending` `src/providers/gemini/media.ts`
- `Pending` `src/providers/gemini/model.ts`
- `Pending` `src/providers/gemini/request.ts`
- `Pending` `src/providers/gemini/schema.ts`
- `Pending` `src/providers/gemini/thought_signature_cache.ts`
- `Pending` `src/providers/gemini/tools.ts`
- `Pending` `src/providers/gemini/urls.ts`

### Claude API Compatibility Layer

- `Skimmed` `src/claude_api.ts`: Claude Messages compat + token estimation + streaming transform.
- `Pending` `src/claude_api/openai_stream_to_messages_sse.ts`
- `Pending` `src/claude_api/openai_to_claude.ts`

### Common

- `Skimmed` `src/common.ts`: common helpers + re-exports. Needs further split candidates.
- `Pending` `src/common/limits.ts`
- `Pending` `src/common/openai_chat_messages.ts`
- `Pending` `src/common/types.ts`

## Refactors Done (dev branch)

- Add `getProviderHintFromBody()` and use it across worker routes (`openai`, `claude`) to reduce drift.
- Add `readFirstStringField()` and use it for endpoint path extraction (`responsesPath`, `chatCompletionsPath`, `messagesPath`) to reduce duplication and `as any` usage.
- Extract auth token parsing into `extractInboundToken()` in `src/worker/handler.ts` and switch auth key lookup to `Set`.
- Deduplicate OpenAI Responses upstream env wiring via `buildOpenAIResponsesUpstreamEnv()` in `src/worker/routes/openai.ts`.

## Refactor Opportunities / TODO

### Worker layer

- Consider table-driven routing in `src/worker/handler.ts` once routes stabilize (less branching, easier to extend).

### Providers / Protocols

- Consider centralizing SSE parsing to use `SseTextStreamParser` in places that currently hand-roll line buffering (only after a dedicated pass + verification).
