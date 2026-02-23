const test = require("node:test");
const assert = require("node:assert/strict");

const { handleWorkerFetch } = require("../dist/test/worker/handler");

test("GET / returns an unauthenticated HTML landing page", async () => {
  const req = new Request("https://example.com/", { method: "GET" });
  const resp = await handleWorkerFetch(req, {});
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") || "", /text\/html/i);
  const text = await resp.text();
  assert.match(text, /rsp4copilot/i);
  assert.ok(text.includes("POST /v1/chat/completions"));
});

test("API routes still require authentication", async () => {
  const req = new Request("https://example.com/v1/models", { method: "GET" });
  const resp = await handleWorkerFetch(req, { WORKER_AUTH_KEY: "inbound" });
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.match(json?.error?.message || "", /Missing API key/i);
});
