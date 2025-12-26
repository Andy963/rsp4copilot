# rsp4copilot (Cloudflare Worker)

把 **OpenAI Responses API** 转换成 OpenAI 兼容的 `/v1/chat/completions` 接口，同时支持 **Gemini** 和 **Claude** 模型。

主要用途：让 VS Code 的 [OAI Compatible Provider for Copilot](https://marketplace.visualstudio.com/items?itemName=nicepkg.oai-compatible-copilot) 插件能够使用 OpenAI Responses API、Gemini、Claude 等模型。

> **注意**：本项目使用 [Claude Relay Server (CRS)](https://github.com/anthropics/claude-relay-server) 等中转服务作为上游，**未适配官方 API Key 直连**。如果你使用官方 API，可能需要自行调整。

## 支持的模型

| 上游 | 模型匹配规则 | 示例 |
|------|-------------|------|
| OpenAI Responses API | 默认 | `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.2`, `gpt-5.2-codex` |
| Gemini API | 以 `gemini-` 开头 | `gemini-3-flash-preview`, `gemini-3-pro-preview` |
| Claude API | 以 `claude-` 开头 | `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101` |

## 快速开始

### 1. 克隆并安装依赖

```bash
git clone https://github.com/user/rsp4copilot.git
cd rsp4copilot
npm install
```

### 2. 复制并编辑配置文件

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，配置你的中转服务 URL：

```toml
[vars]
OPENAI_BASE_URL = "https://your-relay-server.example/openai"
GEMINI_BASE_URL = "https://your-relay-server.example/gemini"
CLAUDE_BASE_URL = "https://your-relay-server.example/api"
```

### 3. 生成 WORKER_AUTH_KEY

这是访问你的 Worker 的密钥，建议使用随机字符串：

```bash
# Linux/macOS
openssl rand -hex 32

# 或使用 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 或使用 Python
python -c "import secrets; print(secrets.token_hex(32))"
```

### 4. 配置 Secrets

```bash
npx wrangler login
npx wrangler secret put WORKER_AUTH_KEY      # 粘贴上一步生成的密钥
npx wrangler secret put OPENAI_API_KEY       # OpenAI API Key
npx wrangler secret put GEMINI_API_KEY       # Gemini API Key（可选）
npx wrangler secret put CLAUDE_API_KEY       # Claude API Key（可选）
```

### 5. 部署

```bash
npm run deploy
```

部署成功后会显示 Worker URL，例如：`https://rsp4copilot.<your-account>.workers.dev`

## 在 VS Code 中使用

### 安装插件

在 VS Code 扩展市场搜索并安装：**OAI Compatible Provider for Copilot**

或直接访问：https://marketplace.visualstudio.com/items?itemName=nicepkg.oai-compatible-copilot

### 配置 settings.json

打开 VS Code 设置（JSON），添加以下配置：

```json
{
  "oaicopilot.baseUrl": "https://rsp4copilot.<your-account>.workers.dev/v1",
  "oaicopilot.models": [
    {
      "id": "gpt-5.1",
      "owned_by": "openai",
      "context_length": 400000,
      "max_tokens": 16384,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "gpt-5.1-codex-max",
      "owned_by": "openai",
      "context_length": 400000,
      "max_tokens": 128000,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "gpt-5.2",
      "owned_by": "openai",
      "context_length": 400000,
      "max_tokens": 16384,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "gpt-5.2-codex",
      "owned_by": "openai",
      "context_length": 400000,
      "max_tokens": 128000,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "gemini-3-flash-preview",
      "owned_by": "google",
      "context_length": 1048576,
      "max_tokens": 65536,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "gemini-3-pro-preview",
      "owned_by": "google",
      "context_length": 1048576,
      "max_tokens": 65536,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "claude-haiku-4-5-20251001",
      "owned_by": "anthropic",
      "context_length": 1048576,
      "max_tokens": 8192,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "claude-sonnet-4-5-20250929",
      "owned_by": "anthropic",
      "context_length": 1048576,
      "max_tokens": 8192,
      "temperature": 0,
      "top_p": 1
    },
    {
      "id": "claude-opus-4-5-20251101",
      "owned_by": "anthropic",
      "context_length": 2097152,
      "max_tokens": 8192,
      "temperature": 0,
      "top_p": 1
    }
  ]
}
```

### 配置 API Key

1. 打开 VS Code 命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）
2. 搜索并运行：`OAICopilot: Set OAI Compatible Multi-Provider Apikey`
3. Provider 选择对应的 `owned_by` 值（如 `openai`、`google`、`anthropic`）
4. API Key 填入你的 `WORKER_AUTH_KEY`（所有 provider 使用同一个 key）

### 使用模型

1. 打开 GitHub Copilot Chat 面板
2. 点击模型选择器 → `Manage Models...` → `OAI Compatible`
3. 勾选你想使用的模型
4. 在聊天中选择对应模型即可使用

## 绑定自定义域名（可选）

如果你有自己的域名，可以在 Cloudflare Dashboard 中绑定：

1. 进入 Cloudflare Dashboard → Workers & Pages → 你的 Worker
2. Settings → Triggers → Custom Domains
3. 添加你的域名（如 `api.yourdomain.com`）

然后把 `oaicopilot.baseUrl` 改为 `https://api.yourdomain.com/v1`

## 上游配置详解

> **重要**：本项目设计用于 [Claude Relay Server (CRS)](https://github.com/anthropics/claude-relay-server) 等中转服务，未适配官方 API Key 直连。以下示例 URL 仅供参考，请替换为你的中转服务地址。

### OpenAI Responses API

```toml
[vars]
OPENAI_BASE_URL = "https://your-relay-server.example/openai"
```

- `RESP_RESPONSES_PATH`（可选）：默认 `/v1/responses`
- `RESP_REASONING_EFFORT`（可选）：`low` / `medium` / `high` / `off`

### Gemini API

```toml
[vars]
GEMINI_BASE_URL = "https://your-relay-server.example/gemini"
GEMINI_DEFAULT_MODEL = "gemini-3-pro-preview"
```

特性：
- 支持 Gemini 2025 API 的 `thought_signature`
- 自动缓存用于多轮对话
- 远程图片自动下载并内联为 base64

### Claude API

```toml
[vars]
CLAUDE_BASE_URL = "https://your-relay-server.example/api"
CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
CLAUDE_MESSAGES_PATH = "/messages" # 可选：覆盖推断出的 Messages API 路径（或用 "/v1/messages"）
CLAUDE_MAX_TOKENS = 8192 # 可选：限制 Claude 输出 token 上限（设为 0 表示不限制）
RSP4COPILOT_DEBUG = "1" # 可选：强制打印调试日志（设为 "0" 关闭）
```

特性：
- 完整支持 Claude Messages API
- 支持 tool_use（函数调用）
- 支持流式输出

## 本地开发

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入你的密钥

npm run dev
```

## curl 测试

```bash
# 测试连接
curl -sS -H "Authorization: Bearer <WORKER_AUTH_KEY>" \
  https://<your-worker>.workers.dev/v1/models

# 测试 OpenAI 模型
curl -sS -H "Authorization: Bearer <WORKER_AUTH_KEY>" \
  -H "Content-Type: application/json" \
  https://<your-worker>.workers.dev/v1/chat/completions \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hello"}]}'

# 测试 Gemini 模型
curl -sS -H "Authorization: Bearer <WORKER_AUTH_KEY>" \
  -H "Content-Type: application/json" \
  https://<your-worker>.workers.dev/v1/chat/completions \
  -d '{"model":"gemini-3-flash-preview","stream":true,"messages":[{"role":"user","content":"hello"}]}'

# 测试 Claude 模型
curl -sS -H "Authorization: Bearer <WORKER_AUTH_KEY>" \
  -H "Content-Type: application/json" \
  https://<your-worker>.workers.dev/v1/chat/completions \
  -d '{"model":"claude-sonnet-4-5-20250929","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

## 调试

```bash
# 终端 1：查看日志
npx wrangler tail rsp4copilot

# 终端 2：发送带 debug header 的请求
curl -sS -H "Authorization: Bearer <WORKER_AUTH_KEY>" \
  -H "x-rsp4copilot-debug: 1" \
  -H "Content-Type: application/json" \
  https://<your-worker>.workers.dev/v1/chat/completions \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"hello"}]}'
```

## License

MIT
