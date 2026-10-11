import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configuredOptions, effectiveMode, saveMode } from "../src/config.js";

const none = () => undefined;
test("config defaults, live rereads, CLI precedence and all modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "search-config-test-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(effectiveMode(configuredOptions(none, path)), "cached");
    for (const mode of ["live", "cached", "indexed", "disabled"] as const) {
      saveMode(mode, path);
      assert.equal(effectiveMode(configuredOptions(none, path)), mode);
    }
    writeFileSync(path, JSON.stringify({ mode: "cached", maxOutputTokens: 500, settings: { external_web_access: false, search_context_size: "high" } }));
    const fromCli = configuredOptions((name) => name === "codex-search-mode" ? "live" : undefined, path);
    assert.equal(effectiveMode(fromCli), "live");
    assert.equal(fromCli.maxOutputTokens, 500);
    assert.equal(fromCli.settings.search_context_size, "high");
    assert.equal(configuredOptions((name) => name === "codex-search-max-output-tokens" ? "700" : undefined, path).maxOutputTokens, 700);
    assert.equal(effectiveMode(configuredOptions((name) => name === "codex-search-settings" ? '{"external_web_access":true}' : undefined, path)), "live");
    saveMode("indexed", path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mode: "indexed", maxOutputTokens: 500, settings: { search_context_size: "high" } });
    assert.deepEqual(readdirSync(dir), ["config.json"]);
    writeFileSync(path, '\uFEFF{"mode":"live"}');
    assert.equal(effectiveMode(configuredOptions(none, path)), "live");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid config fails clearly and is never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "search-config-test-"));
  const path = join(dir, "config.json");
  try {
    for (const text of ['{secret', '[]', '{"mode":"bad"}', '{"mode":null}', '{"unknown":true}', '{"maxOutputTokens":0}', '{"maxOutputTokens":"300"}', '{"settings":null}', '{"settings":{"unknown":true}}']) {
      writeFileSync(path, text);
      assert.throws(() => configuredOptions(none, path));
      assert.throws(() => saveMode("live", path));
      assert.equal(readFileSync(path, "utf8"), text);
    }
    assert.throws(() => configuredOptions(none, dir), /Unable to read/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
