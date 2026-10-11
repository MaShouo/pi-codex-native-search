import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isOpenAIResponsesModel, resolveSearchUrl, searchHeaders } from "../src/client.js";
import { recentInput, truncateTokens } from "../src/history.js";
import { readOptions } from "../src/options.js";
import { COMMANDS_WIRE_SCHEMA, parseCommands, parseSearchResponse } from "../src/schema.js";
import { adaptProviderRequest, namespaceTool, WEB_DESCRIPTION } from "../src/wire.js";

test("provider predicate matches instructions extension's exact boundary", () => {
  for (const provider of ["openai", "OpenAI", "openai-api", "openai_proxy", "openai-ws", "responses-websocket"]) {
    assert.equal(isOpenAIResponsesModel({ provider, api: "openai-responses" }), true, provider);
  }
  for (const provider of ["openaiCompatible", "foo-openai", "azure", "Responses-Websocket", "anthropic", "custom-ws", ""]) {
    assert.equal(isOpenAIResponsesModel({ provider, api: "openai-responses" }), false, provider);
  }
  assert.equal(isOpenAIResponsesModel({ provider: "openai-codex", api: "openai-codex-responses" }), false);
  assert.equal(isOpenAIResponsesModel({ provider: "openai", api: "openai-completions" }), false);
  assert.equal(isOpenAIResponsesModel(undefined), false);
});

test("URLs retain provider origin, path prefix, port and query; no host fallback", () => {
  const cases = [
    ["https://api.openai.com/v1", "https://api.openai.com/v1/alpha/search"],
    ["https://gateway.invalid:9443/team/v1/?key=test", "https://gateway.invalid:9443/team/v1/alpha/search?key=test"],
    ["https://gateway.invalid/v1/responses/", "https://gateway.invalid/v1/alpha/search"],
    ["https://gateway.invalid", "https://gateway.invalid/alpha/search"],
    ["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex/alpha/search"],
    ["https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex/alpha/search"],
    ["wss://gateway.invalid/v1/responses?x=1", "https://gateway.invalid/v1/alpha/search?x=1"],
    ["ws://localhost:3000/v1", "http://localhost:3000/v1/alpha/search"],
  ];
  for (const [input, output] of cases) assert.equal(resolveSearchUrl(input!), output);
  for (const url of ["file:///tmp/key", "https://user:secret@example.com/v1", "https://example.com/v1#secret", "invalid"]) assert.throws(() => resolveSearchUrl(url));
});

test("header precedence, explicit deletion and search-specific header cleanup", () => {
  const result = searchHeaders("KEY", { Authorization: "Bearer model", "X-Tenant": "one", "OpenAI-Beta": "responses=experimental", "Session_ID": "drop", "Content-Length": "999" },
    { authorization: "Bearer resolved", "X-Tenant": null, "chatgpt-account-id": "account", "x-codex-turn-metadata": "metadata" });
  assert.equal(result.get("authorization"), "Bearer resolved");
  assert.equal(result.get("x-tenant"), null);
  assert.equal(result.get("chatgpt-account-id"), "account");
  assert.equal(result.get("x-codex-turn-metadata"), "metadata");
  for (const name of ["openai-beta", "session_id", "content-length"]) assert.equal(result.get(name), null);
  assert.equal(result.get("accept"), "application/json");
  assert.equal(searchHeaders("KEY", undefined, { Authorization: null }).get("authorization"), null);
  assert.equal(searchHeaders(undefined, undefined, { "api-key": "key" }).get("api-key"), "key");
});

test("all official SearchCommands round-trip, without injecting defaults or extra fields", () => {
  const commands = {
    search_query: [{ q: "query", recency: 7, domains: ["example.com"] }], image_query: [{ q: "waterfalls" }],
    open: [{ ref_id: "turn0search0", lineno: 0 }], click: [{ ref_id: "turn1view0", id: 2 }],
    find: [{ ref_id: "turn1view0", pattern: "pattern" }], screenshot: [{ ref_id: "turn1view0", pageno: 0 }],
    finance: [{ ticker: "BTC", type: "crypto", market: "" }], weather: [{ location: "Country, Area, City", start: "2026-01-01", duration: 7 }],
    sports: [{ tool: "sports", fn: "schedule", league: "nba", team: "GSW", opponent: "LAL", date_from: "2026-01-01", date_to: "2026-01-07", num_games: 3, locale: "en-US" }],
    time: [{ utc_offset: "+03:00" }], response_length: "long",
  };
  assert.deepEqual(parseCommands(commands), commands);
  assert.deepEqual(parseCommands({}), {});
  assert.deepEqual(parseCommands({ search_query: [{ q: "", injected: "ignored" }], model: "ignore" }), { search_query: [{ q: "" }] });
  for (const invalid of [{ search_query: [{ q: 1 }] }, { open: [{ ref_id: "url", lineno: -1 }] }, { screenshot: [{ ref_id: "x", pageno: 0.5 }] }, { finance: [{ ticker: "x", type: "bad" }] }, { response_length: "huge" }, null]) assert.throws(() => parseCommands(invalid));
});

test("normalized schema matches independently derived pinned Rust fixture", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/commands-schema.json", import.meta.url), "utf8"));
  assert.deepEqual(COMMANDS_WIRE_SCHEMA, fixture);
  assert.doesNotMatch(JSON.stringify(COMMANDS_WIRE_SCHEMA), /"minimum"|"maximum"|"format"/);
  assert.ok(WEB_DESCRIPTION.includes("`search_query` must have length at most 4"));
});

test("response contract: required plaintext, opaque optional results, empty output allowed", () => {
  assert.deepEqual(parseSearchResponse({ output: "", results: [], extra: "ignored" }), { output: "", results: [] });
  assert.deepEqual(parseSearchResponse({ output: "exact\n", results: [{ type: "future_type", opaque: true }], encrypted_output: "discarded by executor" }).results, [{ type: "future_type", opaque: true }]);
  assert.deepEqual(parseSearchResponse({ output: "text", results: null }), { output: "text", results: null });
  for (const value of [{ encrypted_output: "cipher" }, { output: null }, { output: "text", results: {} }, { output: "text", encrypted_output: 4 }, []]) assert.throws(() => parseSearchResponse(value));
});

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });
test("official recent context retains last two users and text between them only", () => {
  const input = recentInput([
    { role: "system", content: "PRIVATE SYSTEM" }, user("old"), assistant("old answer"), user([{ type: "text", text: "previous" }, { type: "image", data: "PRIVATE" }]),
    { role: "toolResult", content: "PRIVATE TOOL" }, assistant([{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "answer" }]),
    { role: "custom", content: "PRIVATE" }, user("current"), assistant("current commentary should be omitted"),
  ]);
  assert.deepEqual(input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "previous" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current" }] },
  ]);
  assert.equal(recentInput([assistant("no user")]), undefined);
  assert.equal(recentInput([user([{ type: "image", data: "image" }])]), undefined);
});
test("assistant 1000 token budget is shared and UTF-8 middle truncation matches Codex", () => {
  const input = recentInput([user("first"), assistant("a".repeat(16)), assistant("你".repeat(3000)), assistant("omit"), user("last")])!;
  assert.equal(input.length, 4);
  assert.equal(input[2]!.content[0]!.text, truncateTokens("你".repeat(3000), 996));
  assert.equal(truncateTokens("a".repeat(16), 2), "aaaa…2 tokens truncated…aaaa");
  assert.equal(truncateTokens("你".repeat(4), 2), "你…1 tokens truncated…你");
  assert.equal(truncateTokens("abc", 0), "…1 tokens truncated…");
  assert.doesNotMatch(JSON.stringify(input), /�/);
});

test("options follow cached/indexed/live semantics and strict explicit settings", () => {
  const options = (values: Record<string, string | undefined>) => readOptions((name) => values[name]);
  assert.deepEqual(options({}), { enabled: true, maxOutputTokens: 10000, settings: { allowed_callers: ["direct"], external_web_access: false } });
  assert.equal(options({ "codex-search-mode": "indexed" }).settings.external_web_access, "indexed");
  assert.equal(options({ "codex-search-mode": "live" }).settings.external_web_access, true);
  assert.equal(options({ "codex-search-mode": "disabled" }).enabled, false);
  const settings = { search_context_size: "high", filters: { allowed_domains: ["example.com"], blocked_domains: ["example.org"] }, user_location: { type: "approximate", country: "US" }, image_settings: { max_results: 2, caption: true }, allowed_callers: ["shell"], external_web_access: "live" };
  assert.deepEqual(options({ "codex-search-settings": JSON.stringify(settings) }).settings, settings);
  for (const values of [{ "codex-search-mode": "bad" }, { "codex-search-settings": "[]" }, { "codex-search-settings": '{"unknown":true}' }, { "codex-search-max-output-tokens": "0" }, { "codex-search-max-output-tokens": "1.5" }]) assert.throws(() => options(values));
});

test("native namespace declaration, replay and plaintext output; unrelated tools untouched", () => {
  const payload = { tools: [{ type: "function", name: "web.run", parameters: { compacted: true } }, { type: "function", name: "bash" }, { type: "web_search" }],
    input: [{ type: "function_call", call_id: "one", name: "web.run", arguments: "{}" }, { type: "function_call_output", call_id: "one", output: "exact" }, { type: "function_call_output", call_id: "two", output: "bash output" }],
    tool_choice: { type: "function", name: "web.run" }, store: false };
  const original = structuredClone(payload);
  const result = adaptProviderRequest(payload)!;
  assert.deepEqual(result.tools, [namespaceTool(), { type: "function", name: "bash" }]);
  assert.deepEqual(result.input, [
    { type: "function_call", call_id: "one", name: "run", namespace: "web", arguments: "{}" },
    { type: "function_call_output", call_id: "one", output: [{ type: "input_text", text: "exact" }] },
    { type: "function_call_output", call_id: "two", output: "bash output" },
  ]);
  assert.deepEqual(result.tool_choice, { type: "function", name: "run", namespace: "web" });
  assert.equal(result.store, false);
  assert.deepEqual(payload, original);
  assert.equal(adaptProviderRequest(result), undefined);
});
test("codemode-hidden tools are not re-injected; old web calls still get valid replay", () => {
  assert.equal(adaptProviderRequest({ tools: [{ type: "function", name: "codemode" }, { type: "web_search" }] }), undefined);
  const result = adaptProviderRequest({ tools: [], input: [{ type: "function_call", call_id: "one", name: "web.run", arguments: "{}" }] })!;
  assert.deepEqual(result.tools, []);
  assert.equal((result.input as { namespace: string }[])[0]!.namespace, "web");
});
