import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// Exercise Pi's real jiti loader, without a user AgentSession, auth storage or model call.
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("Pi 1.1.0 loads the TS package and its vendored description offline", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const result = await loadExtensions([entry], root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0]!;
  const tool = extension.tools.get("web.run")!.definition;
  assert.equal(tool.exposure, "hidden");
  assert.ok(tool.description.includes("Tool for accessing the internet."));
  assert.equal(extension.flags.size, 3);
  assert.ok(extension.handlers.has("before_provider_request"));
  assert.ok(extension.handlers.has("message_end"));
  assert.deepEqual(result.runtime.pendingProviderRegistrations, []);
  assert.deepEqual(result.runtime.pendingNativeProviderRegistrations, []);
});
