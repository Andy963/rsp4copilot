const test = require("node:test");
const assert = require("node:assert/strict");

const { parseGatewayConfig } = require("../dist/test/config");
const { handleWorkerFetch } = require("../dist/test/worker/handler");

test("parseGatewayConfig rejects missing config", () => {
  const res = parseGatewayConfig({});
  assert.equal(res.ok, false);
  assert.equal(res.source, "none");
  assert.match(res.error, /Missing RSP4COPILOT_CONFIG/);
});

test("parseGatewayConfig rejects missing providers", () => {
  const res = parseGatewayConfig({ RSP4COPILOT_CONFIG: "{\"version\":1}" });
  assert.equal(res.ok, false);
  assert.equal(res.source, "env");
  assert.match(res.error, /Missing providers/);
});

test("parseGatewayConfig rejects provider ids containing '.'", () => {
  const cfg = {
    version: 1,
    providers: {
      "bad.id": {
        apiMode: "openai-chat-completions",
        baseURL: "https://example.com",
        apiKey: "k",
        models: { "gpt-test": {} },
      },
    },
  };
  const res = parseGatewayConfig({ RSP4COPILOT_CONFIG: JSON.stringify(cfg) });
  assert.equal(res.ok, false);
  assert.match(res.error, /must not contain '\.':/);
});

test("parseGatewayConfig rejects providers with no models configured", () => {
  const cfg = {
    version: 1,
    providers: {
      p: {
        apiMode: "openai-chat-completions",
        baseURL: "https://example.com",
        apiKey: "k",
        models: {},
      },
    },
  };
  const res = parseGatewayConfig({ RSP4COPILOT_CONFIG: JSON.stringify(cfg) });
  assert.equal(res.ok, false);
  assert.match(res.error, /no models configured/);
});

test("parseGatewayConfig rejects invalid baseURL values", () => {
  const cfg = {
    version: 1,
    providers: {
      p: {
        apiMode: "openai-chat-completions",
        baseURL: "https://",
        apiKey: "k",
        models: { "gpt-test": {} },
      },
    },
  };
  const res = parseGatewayConfig({ RSP4COPILOT_CONFIG: JSON.stringify(cfg) });
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid baseURL/);
});

test("loop guard rejects self-forward baseURLs", async () => {
  const cfg = {
    version: 1,
    providers: {
      p: {
        apiMode: "openai-chat-completions",
        baseURL: "https://example.com",
        apiKey: "k",
        models: { "gpt-test": {} },
      },
    },
  };
  const env = {
    WORKER_AUTH_KEY: "inbound",
    RSP4COPILOT_CONFIG: JSON.stringify(cfg),
  };

  const req = new Request("https://example.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer inbound", "content-type": "application/json" },
    body: "{}",
  });

  const resp = await handleWorkerFetch(req, env);
  assert.equal(resp.status, 500);
  const json = await resp.json();
  assert.match(json?.error?.message || "", /infinite routing loop/i);
});
