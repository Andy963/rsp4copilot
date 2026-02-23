const test = require("node:test");
const assert = require("node:assert/strict");

const { selectUpstreamResponseAny } = require("../dist/test/providers/openai/upstream_select");

test("circuit breaker skips unhealthy upstreams after repeated failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("u1.test")) {
      return new Response("fail", { status: 503, headers: { "content-type": "text/plain" } });
    }
    return new Response("ok", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const opts = { circuitBreakerFailureThreshold: 2, circuitBreakerCooldownMs: 60_000 };

    calls.length = 0;
    const sel1 = await selectUpstreamResponseAny(["https://u1.test", "https://u2.test"], { "content-type": "application/json" }, [{}], false, "", opts);
    assert.equal(sel1.ok, true);
    assert.equal(sel1.upstreamUrl, "https://u2.test");
    assert.deepEqual(
      calls.map((c) => (c.includes("u1.test") ? "u1" : "u2")),
      ["u1", "u2"],
    );

    calls.length = 0;
    const sel2 = await selectUpstreamResponseAny(["https://u1.test", "https://u2.test"], { "content-type": "application/json" }, [{}], false, "", opts);
    assert.equal(sel2.ok, true);
    assert.equal(sel2.upstreamUrl, "https://u2.test");
    assert.deepEqual(
      calls.map((c) => (c.includes("u1.test") ? "u1" : "u2")),
      ["u1", "u2"],
    );

    calls.length = 0;
    const sel3 = await selectUpstreamResponseAny(["https://u1.test", "https://u2.test"], { "content-type": "application/json" }, [{}], false, "", opts);
    assert.equal(sel3.ok, true);
    assert.equal(sel3.upstreamUrl, "https://u2.test");
    assert.deepEqual(
      calls.map((c) => (c.includes("u1.test") ? "u1" : "u2")),
      ["u2"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

