import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../src/index.js";
import type { SearchDetails } from "../src/index.js";
import type { TransportOptions } from "../src/client.js";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
function harness(transport: TransportOptions = {}, initialFlags: Record<string, string> = {}, configurationPath: string | null = null) {
  const tools = new Map<string, Tool>();
  const flags = new Map<string, string | boolean>(Object.entries(initialFlags));
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const notices: { message: string; level: string }[] = [];
  let active: string[] = [];
  const pi = {
    registerFlag(name: string, definition: { default?: string | boolean }) { if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default); },
    getFlag(name: string) { return flags.get(name); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    getActiveTools() { return active; },
    registerTool(tool: Tool) { tools.set(tool.name, tool); if (tool.exposure === "hidden") active = active.filter((name) => name !== tool.name); else if (tool.defaultActive !== false && !active.includes(tool.name)) active.push(tool.name); },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  let authCalls = 0;
  const model = { id: "gpt-test", api: "openai-responses", provider: "openai-proxy", baseUrl: "https://model.invalid/v1", headers: { "x-model": "model" } };
  const state = { sessionId: "session-one", messages: [
    { role: "system", content: "PRIVATE SYSTEM" }, { role: "user", content: "previous" },
    { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "PRIVATE" }] },
    { role: "user", content: "current" },
  ] as unknown[], auth: { ok: true, apiKey: "FAKE-KEY", baseUrl: "https://auth.invalid/team/v1", headers: { "x-auth": "auth", "ChatGPT-Account-ID": "account" } } as any };
  const ctx = {
    hasUI: true, ui: { notify: (message: string, level: string) => notices.push({ message, level }), select: async () => undefined },
    model, sessionManager: {
      getSessionId: () => state.sessionId,
      buildSessionProjection: () => ({ messages: state.messages }),
    }, modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return state.auth; } },
  } as unknown as ExtensionContext;
  createExtension(transport, configurationPath)(pi);
  return {
    tools, flags, handlers, state, ctx, commands, notices,
    authCalls: () => authCalls,
    active: () => active,
    disable: () => { active = []; },
    emit: async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    execute: (params: unknown = { search_query: [{ q: "test" }] }, signal?: AbortSignal) => tools.get("web.run")!.execute("call-one", params as any, signal, undefined, ctx as Parameters<Tool["execute"]>[4]),
  };
}
test("mode command persists, updates availability, cancels cleanly and reports CLI overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "search-command-test-"));
  const path = join(dir, "config.json");
  try {
    const sent: any[] = [];
    const h = harness({ fetch: fakeFetch(async (_url, init) => { sent.push(JSON.parse(init.body as string)); return Response.json({ output: "ok" }); }) }, {}, path);
    const command = h.commands.get("codex-search");
    assert.deepEqual(command.getArgumentCompletions("li"), [{ value: "live", label: "live" }]);
    await command.handler("live", h.ctx);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { mode: "live" });
    assert.equal(h.tools.get("web.run")!.exposure, "direct");
    await h.execute();
    assert.equal(sent.at(-1).settings.external_web_access, true);
    await command.handler("disabled", h.ctx);
    assert.equal(h.tools.get("web.run")!.exposure, "hidden");
    await assert.rejects(h.execute(), /disabled/);
    await command.handler("indexed", h.ctx);
    assert.equal(h.tools.get("web.run")!.exposure, "direct");
    await h.execute();
    assert.equal(sent.at(-1).settings.external_web_access, "indexed");
    await writeFile(path, '{"mode":"cached"}');
    await h.execute();
    assert.equal(sent.at(-1).settings.external_web_access, false, "file edits are read on next call");
    const before = await readFile(path, "utf8");
    await command.handler("", h.ctx);
    await command.handler("invalid", h.ctx);
    assert.equal(await readFile(path, "utf8"), before);
    (h.ctx.ui as any).select = async () => "live";
    await command.handler("", h.ctx);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { mode: "live" });
    h.flags.set("codex-search-mode", "cached");
    await command.handler("live", h.ctx);
    assert.match(h.notices.at(-1)!.message, /CLI overrides/);
    assert.equal(h.notices.at(-1)!.level, "warning");
    await writeFile(path, "{broken");
    await command.handler("live", h.ctx);
    assert.equal(h.notices.at(-1)!.level, "error");
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const fakeFetch = (handler: (url: string, init: RequestInit) => Promise<Response>) => handler as typeof fetch;

test("loading, lifecycle and provider switching never resolve auth or make network calls", async () => {
  const h = harness();
  assert.equal(h.tools.get("web.run")!.exposure, "hidden");
  assert.deepEqual(h.active(), []);
  await h.emit("session_start");
  assert.deepEqual(h.active(), ["web.run"]);
  h.disable();
  await h.emit("before_agent_start");
  assert.deepEqual(h.active(), [], "manual deactivation must not be undone each turn");
  (h.ctx.model as any).provider = "anthropic";
  await h.emit("model_select");
  assert.equal(h.tools.get("web.run")!.exposure, "hidden");
  await assert.rejects(h.execute(), /eligible/);
  (h.ctx.model as any).provider = "responses-websocket";
  await h.emit("model_select");
  assert.equal(h.tools.get("web.run")!.exposure, "direct");
  assert.equal(h.tools.get("web.run")!.defaultActive, false);
  assert.deepEqual(h.active(), [], "manual deactivation survives a model round trip");
  assert.equal(h.authCalls(), 0);
});

test("wire request follows official body, uses auth-resolved URL, and retains branch context", async () => {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const h = harness({ fetch: fakeFetch(async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
    return Response.json({ output: "EXACT output\n", results: [{ type: "unknown", value: "kept" }], encrypted_output: "NOT USED" });
  }) });
  const result = await h.execute();
  assert.deepEqual(result.content, [{ type: "text", text: "EXACT output\n" }]);
  assert.deepEqual(result.details, { sessionId: "session-one", provider: "openai-proxy", model: "gpt-test", results: [{ type: "unknown", value: "kept" }] });
  const sent = requests[0]!;
  assert.equal(sent.url, "https://auth.invalid/team/v1/alpha/search");
  assert.equal(sent.headers.get("authorization"), "Bearer FAKE-KEY");
  assert.equal(sent.headers.get("x-auth"), "auth");
  assert.equal(sent.headers.get("x-model"), "model");
  assert.equal(sent.headers.get("chatgpt-account-id"), "account");
  assert.deepEqual(sent.body, {
    id: "session-one", model: "gpt-test",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "previous" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "current" }] },
    ],
    commands: { search_query: [{ q: "test" }] }, settings: { allowed_callers: ["direct"], external_web_access: false }, max_output_tokens: 10000,
  });
  await h.execute({ open: [{ ref_id: "turn0search0" }] });
  assert.equal(requests[1]!.body.id, "session-one");
  assert.deepEqual(requests[1]!.body.commands, { open: [{ ref_id: "turn0search0" }] });
  h.state.sessionId = "forked-session";
  h.state.messages = [{ role: "user", content: "fork question" }];
  await h.execute();
  assert.equal(requests[2]!.body.id, "forked-session");
  assert.equal(requests[2]!.body.input.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /FAKE-KEY|NOT USED/);
});

test("no history omits input; empty official command object is accepted", async () => {
  const h = harness({ fetch: fakeFetch(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    assert.equal("input" in body, false);
    assert.deepEqual(body.commands, {});
    return Response.json({ output: "" });
  }) });
  h.state.messages = [];
  assert.deepEqual((await h.execute({})).content, [{ type: "text", text: "" }]);
});

test("disabled, invalid commands, pre-abort and auth failure stop before fetch", async () => {
  const disabled = harness({}, { "codex-search-mode": "disabled" });
  await disabled.emit("session_start");
  assert.deepEqual(disabled.active(), []);
  await assert.rejects(disabled.execute(), /disabled/);
  const h = harness();
  await assert.rejects(h.execute({ open: [{ ref_id: 4 }] }), /commands/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.execute({}, controller.signal));
  assert.equal(h.authCalls(), 0);
  h.state.auth = { ok: false, error: "secret in error" };
  await assert.rejects(h.execute(), (error: Error) => /authentication/.test(error.message) && !error.message.includes("secret"));
});

test("native namespace calls normalize before execution and replay only for matching providers", async () => {
  const h = harness();
  const message = { role: "assistant", provider: "openai-proxy", api: "openai-responses", content: [
    { type: "toolCall", id: "call-one", name: "run", namespace: "web", arguments: { search_query: [{ q: "test" }] } },
    { type: "toolCall", id: "call-two", name: "run", namespace: "other", arguments: {} },
  ] };
  const normalized = await h.emit("message_end", { message });
  assert.equal(normalized.message.content[0].name, "web.run");
  assert.equal(normalized.message.content[0].namespace, "web");
  assert.equal(normalized.message.content[1].name, "run");
  assert.equal(message.content[0]!.name, "run", "do not mutate stream data");
  const result = await h.emit("before_provider_request", { payload: { tools: [{ type: "function", name: "web.run" }], input: [] } });
  assert.equal(result.tools[0].type, "namespace");
  (h.ctx.model as any).provider = "unrelated";
  assert.equal(await h.emit("before_provider_request", { payload: { tools: [{ type: "function", name: "web.run" }] } }), undefined);
  assert.equal(await h.emit("message_end", { message: { ...message, provider: "unrelated" } }), undefined);
});

test("oversize output is bounded with exact full output saved, not silently discarded", async () => {
  const fullOutput = "line\n".repeat(2200);
  const h = harness({ fetch: fakeFetch(async () => Response.json({ output: fullOutput })) });
  const result = await h.execute();
  const path = (result.details as SearchDetails).fullOutputPath!;
  try {
    assert.ok(path);
    assert.equal(await readFile(path, "utf8"), fullOutput);
    assert.ok(result.content[0]!.type === "text" && result.content[0].text.includes("Output truncated by Pi"));
  } finally { if (path) await rm(dirname(path), { recursive: true, force: true }); }
});
