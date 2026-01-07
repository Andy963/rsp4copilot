# rsp4copilot 网关化改造计划（JS -> TS + 多协议 + 配置驱动路由）

> 目标：在**不部署**的前提下，把当前 rsp4copilot 从「仅 OpenAI Chat 入口 + 前缀路由」升级为：
> - 同时暴露：OpenAI Chat、OpenAI Responses、Claude Messages、Gemini generateContent/stream
> - 路由方式：配置驱动（`model` 支持短 ID 或 `providerId.modelName`）
> - 保留：现有 WORKER_AUTH_KEY 鉴权、基础 debug 日志能力

---

## 1. 目标接口清单（完成标准）

### 1.1 OpenAI 风格
- `POST /v1/chat/completions`（兼容别名：`/chat/completions`）
- `GET /v1/models`（兼容别名：`/models`、`/openai/v1/models`、`/claude/v1/models`）
- 可选保留：`POST /v1/completions`（兼容别名：`/completions`，仅作为 legacy/兼容入口，不做本次主要目标）

### 1.2 OpenAI Responses 风格
- `POST /v1/responses`（兼容别名：`/responses`、`/openai/v1/responses`）

### 1.3 Claude 风格
- `POST /claude/v1/messages`
- `POST /claude/v1/messages/count_tokens`

### 1.4 Gemini 风格
- `GET /gemini/v1beta/models`
- `POST /gemini/v1beta/models/{modelId}:generateContent`
- `POST /gemini/v1beta/models/{modelId}:streamGenerateContent?alt=sse`

### 1.5 健康检查
- `GET /health`、`GET /v1/health`

---

## 2. 配置与路由（完成标准）

### 2.1 统一模型命名
- `model` 支持两种写法：
  - 短 ID：`modelName`（推荐；前提是该名字在所有 provider 里唯一）
  - 完整 ID：`providerId.modelName`（显式指定 provider；当短 ID 有歧义时使用）
- 可选 provider hint：JSON body 的 `provider` / `owned_by` / `ownedBy`；Gemini 额外支持 `?provider=`

### 2.2 网关配置
- 新增单一 JSON/JSONC 配置环境变量：
  - `RSP4COPILOT_CONFIG`
- 配置 schema（version=1）：
  - `providers.<id>.apiMode`（兼容：`api_mode` / `type`）：`openai-responses` | `openai-chat-completions` | `gemini` | `claude`
  - `providers.<id>.ownedBy`（可选）：用于 `/v1/models` 的 `owned_by`，以及 provider hint 匹配（默认按 apiMode 推断：openai/google/anthropic）
  - `providers.<id>.baseURL`：字符串或字符串数组（支持逗号分隔的上游 fallback）
  - `providers.<id>.apiKey` 或 `providers.<id>.apiKeyEnv`
  - `providers.<id>.models.<modelName>.upstreamModel`（可选，默认同名）
  - `providers.<id>.quirks/options/endpoints`：按需扩展（与 any-api 对齐）

### 2.3 鉴权（保持/完成标准）
- Worker 入站鉴权保持强制：
  - `Authorization: Bearer <key>` 或 `Authorization: <key>`
  - `x-api-key: <key>`
  - Gemini 兼容：`x-goog-api-key` 或 `?key=`（仅当路径以 `/gemini/` 开头）

---

## 3. 代码改造步骤（按顺序执行）

### Step 0：准备/风险控制
- [x] `git status` 保持 clean（便于回滚）
- [x] 不执行 `wrangler deploy`

### Step 1：TypeScript 基础设施
- [x] 新增 `tsconfig.json`（面向 Cloudflare Workers）
- [x] 添加 `@cloudflare/workers-types` devDependency
- [x] Wrangler 入口从 `worker.js` 切换到 `src/workers.ts`
- [x] 删除/下线旧的 `worker.js`（避免入口混淆）

验证：
- [x] `npm run typecheck` 通过

### Step 2：迁移核心 runtime（Worker 路由层）
- [x] 新增 `src/workers.ts`（路由、鉴权、CORS、日志）
- [x] 迁移并统一公共工具到 `src/common.ts`

验证：
- [x] `wrangler dev --local` 能启动（不需要真实上游 key 也应能返回 401/500 这类可预期错误）

### Step 3：配置驱动路由模块
- [x] 新增 `src/jsonc.ts`：支持 JSONC（注释、尾逗号）
- [x] 新增 `src/config.ts`：解析/校验 `RSP4COPILOT_CONFIG`
- [x] 新增 `src/model_resolver.ts`：解析 `model`（短 ID / `providerId.modelName`），并支持 provider hint
- [x] 新增 `src/models_list.ts`：生成 `/v1/models` 与 `/gemini/v1beta/models`
- [x] 新增 `src/dispatch.ts`：把 OpenAI Chat 请求分发到各 provider type

验证：
- [x] `GET /v1/models` 在配置存在时返回配置里的模型列表

### Step 4：多协议互转（入站协议 -> OpenAI Chat -> provider -> 出站协议）
- [x] 新增 `src/protocols/responses.ts`：Responses <-> Chat
- [x] 新增 `src/protocols/gemini.ts`：Gemini <-> Chat
- [x] 新增 `src/protocols/stream.ts`：OpenAI Chat SSE -> Gemini/Responses SSE
- [x] 新增 `src/claude_api.ts`：Claude Messages <-> Chat、count_tokens、Claude SSE
- [x] 在 `src/workers.ts` 按路径接入所有入口协议

验证：
- [x] 每条路由都能走到「鉴权->解析->转换->分发」流程（无上游 key 时返回明确错误）

### Step 5：文档与样例更新（不部署）
- [x] 更新 `README.md`：新增协议入口、模型命名、配置示例、curl 示例
- [x] 更新 `.dev.vars.example` 与 `wrangler.toml.example`：改为配置驱动示例
- [x] 如保留 legacy：说明 legacy 行为与迁移建议

---

## 4. 本地验证命令（不部署）

```bash
npm run typecheck

# 本地跑 Worker（建议 local 模式避免触发远程 dev）
wrangler dev --local --port 8788

# 仅验证鉴权/路由是否生效（预期 401 或 500 配置错误）
curl -sS http://127.0.0.1:8788/v1/health -H "Authorization: Bearer REPLACE_ME"
curl -sS http://127.0.0.1:8788/v1/models -H "Authorization: Bearer REPLACE_ME"
```

---

## 5. 交付物清单
- `src/**/*.ts`：TypeScript 版本实现
- `tsconfig.json`：TS 配置
- `wrangler.toml` / `wrangler.toml.example`：入口与变量示例更新
- `.dev.vars.example`：本地开发变量示例更新
- `README.md`：使用说明更新
