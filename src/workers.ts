/**
 * rsp4copilot on Cloudflare Workers
 *
 * Inbound protocols:
 * - OpenAI Chat Completions: `POST /v1/chat/completions`
 * - OpenAI Responses:        `POST /v1/responses` (aliases: `/responses`, `/openai/v1/responses`)
 * - Claude Messages:         `POST /claude/v1/messages`, `POST /claude/v1/messages/count_tokens`
 * - Gemini:                  `POST /gemini/v1beta/models/{model}:generateContent`,
 *                            `POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`
 *
 * Routing:
 * - Config-driven (`modelName` or `providerId.modelName`) via `RSP4COPILOT_CONFIG` (required)
 */

import type { Env } from "./common";
import { handleWorkerFetch } from "./worker/handler";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkerFetch(request, env);
  },
};

