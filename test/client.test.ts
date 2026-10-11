import assert from "node:assert/strict";
import { test } from "node:test";
import { requestSearch } from "../src/client.js";
import type { SearchRequest } from "../src/schema.js";

const request: SearchRequest = { id: "session", model: "model", commands: { search_query: [{ q: "query" }] }, settings: { allowed_callers: ["direct"], external_web_access: false }, max_output_tokens: 10000 };
const url = "https://provider.invalid/v1/alpha/search";
const headers = new Headers({ Authorization: "Bearer TEST-SECRET" });
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as typeof fetch;
const success = () => Response.json({ output: "Exact\noutput", results: [{ type: "future", opaque: [1] }] });

test("JSON-only POST has exact request fields, no extra Responses turn or SSE", async () => {
  let count = 0;
  const response = await requestSearch(url, headers, request, { fetch: fakeFetch(async (target, init) => {
    count++;
    assert.equal(target, url);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body as string), request);
    assert.deepEqual(Object.keys(JSON.parse(init.body as string)).sort(), ["commands", "id", "max_output_tokens", "model", "settings"]);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer TEST-SECRET");
    assert.ok(init.signal instanceof AbortSignal);
    return success();
  }) });
  assert.equal(count, 1);
  assert.deepEqual(response, { output: "Exact\noutput", results: [{ type: "future", opaque: [1] }] });
});

test("5xx and transport errors retry four times with official backoff and unchanged id", async () => {
  const bodies: string[] = [];
  const sleeps: number[] = [];
  await assert.rejects(requestSearch(url, headers, request, {
    fetch: fakeFetch(async (_url, init) => { bodies.push(init.body as string); return new Response("server TEST-SECRET", { status: 503 }); }),
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5,
  }), /HTTP 503/);
  assert.equal(bodies.length, 5);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(sleeps, [200, 400, 800, 1600]);
  let count = 0;
  await assert.rejects(requestSearch(url, headers, request, {
    fetch: fakeFetch(async () => { count++; throw new Error("network error contains TEST-SECRET"); }), sleep: async () => {},
  }), (error: Error) => /five attempts/.test(error.message) && !error.message.includes("TEST-SECRET"));
  assert.equal(count, 5);
});

test("transient retry succeeds and honors Retry-After", async () => {
  let count = 0;
  const sleeps: number[] = [];
  await requestSearch(url, headers, request, {
    fetch: fakeFetch(async () => ++count === 1 ? new Response(null, { status: 503, headers: { "Retry-After": "3" } }) : success()),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(count, 2);
  assert.deepEqual(sleeps, [3000]);
});

for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 405, 429]) {
  test(`HTTP ${status} is not retried, redirected or replaced with Responses`, async () => {
    let count = 0;
    await assert.rejects(requestSearch(url, headers, request, {
      fetch: fakeFetch(async () => { count++; return new Response("TEST-SECRET", { status, headers: { Location: "https://different.invalid/steal" } }); }),
      sleep: async () => { assert.fail("must not sleep"); },
    }), (error: Error) => error.message.includes(`HTTP ${status}`) && !error.message.includes("TEST-SECRET"));
    assert.equal(count, 1);
  });
}

test("JSON/schema errors are not retried; opaque results preserved", async () => {
  for (const payload of ["not json", '{"encrypted_output":"opaque"}', '{"output":"yes","results":{}}', '{"output":1}']) {
    let count = 0;
    await assert.rejects(requestSearch(url, headers, request, {
      fetch: fakeFetch(async () => { count++; return new Response(payload); }), sleep: async () => { assert.fail("must not retry"); },
    }));
    assert.equal(count, 1);
  }
});

test("pre-aborted calls make zero requests", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestSearch(url, headers, request, { signal: abort.signal, fetch: fakeFetch(async () => { assert.fail("must not fetch"); }) }), /cancelled/);
});
test("cancellation while waiting on the network and during backoff", async () => {
  const abort = new AbortController();
  await assert.rejects(requestSearch(url, headers, request, { signal: abort.signal, fetch: fakeFetch(async () => { abort.abort(); throw new Error("aborted"); }) }), /cancelled/);
  const other = new AbortController();
  let count = 0;
  await assert.rejects(requestSearch(url, headers, request, {
    signal: other.signal, fetch: fakeFetch(async () => { count++; return new Response(null, { status: 503 }); }),
    sleep: async (_ms, signal) => { other.abort(); signal.throwIfAborted(); },
  }), /cancelled/);
  assert.equal(count, 1);
});

test("whole-operation deadline covers a stalled body and long Retry-After", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    let cancelled = false;
    await assert.rejects(requestSearch(url, headers, request, {
      timeoutMs: 10,
      fetch: fakeFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))),
    }), /timed out/);
    assert.equal(cancelled, true);
    let count = 0;
    await assert.rejects(requestSearch(url, headers, request, {
      timeoutMs: 10, fetch: fakeFetch(async () => { count++; return new Response(null, { status: 503, headers: { "Retry-After": "999" } }); }),
    }), /timed out/);
    assert.equal(count, 1);
  } finally { clearInterval(keepAlive); }
});

test("bounds declared and streamed body sizes without retry", async () => {
  for (const response of [new Response("oversized", { headers: { "content-length": "9999" } }), new Response("x".repeat(1000))]) {
    let count = 0;
    await assert.rejects(requestSearch(url, headers, request, {
      maxResponseBytes: 32, fetch: fakeFetch(async () => { count++; return response; }),
    }), /byte limit/);
    assert.equal(count, 1);
  }
});

test("test harness blocks accidental global fetch", () => {
  assert.throws(() => globalThis.fetch("https://example.invalid"), /NETWORK DISABLED/);
});
