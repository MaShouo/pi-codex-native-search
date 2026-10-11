// OFFLINE ONLY: derive a review fixture from the pinned local Codex Rust types.
// This limited extractor covers SearchCommands' structs/unit enums; it is NOT
// a general Rust/Schemars implementation. Never fetches or executes Codex.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const commit = "cc7ba33601286a751477832b01de7b6f8de0dd9c";
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/sync-upstream.mjs <local-codex-checkout>");
if (execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) throw new Error("Checkout does not match the reviewed Codex commit.");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(resolve(checkout, "codex-rs/codex-api/src/search.rs"), "utf8");
const structs = new Map([...source.matchAll(/pub struct (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]));
const enums = new Map([...source.matchAll(/pub enum (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]));
function schema(type) {
  if (type === "String") return { type: "string" };
  if (type === "u64") return { type: "integer" };
  if (type.startsWith("Vec<")) return { type: "array", items: schema(type.slice(4, -1)) };
  if (enums.has(type)) {
    const variants = enums.get(type).split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    if (!variants.every((v) => /^[A-Za-z]+,$/.test(v))) throw new Error(`Not a unit enum: ${type}`);
    return { type: "string", enum: variants.map((v) => v.slice(0, -1).toLowerCase()) };
  }
  const body = structs.get(type);
  if (!body) throw new Error(`Unknown Rust type: ${type}`);
  const properties = {};
  const required = [];
  let docs = [];
  for (const line of body.split(/\r?\n/)) {
    const doc = line.trim().match(/^\/\/\/ ?(.*)$/);
    if (doc) { docs.push(doc[1]); continue; }
    const field = line.match(/^\s*pub (?:r#)?(\w+): (.+),$/);
    if (!field) continue;
    const optional = field[2].startsWith("Option<");
    const fieldType = optional ? field[2].slice(7, -1) : field[2];
    properties[field[1]] = { ...schema(fieldType), ...(docs.length ? { description: docs.join("\n") } : {}) };
    if (!optional) required.push(field[1]);
    docs = [];
  }
  return { type: "object", properties, ...(required.length ? { required: required.sort() } : {}) };
}
mkdirSync(resolve(root, "test/fixtures"), { recursive: true });
writeFileSync(resolve(root, "test/fixtures/commands-schema.json"), JSON.stringify(schema("SearchCommands"), null, 2) + "\n");
mkdirSync(resolve(root, "src/vendor"), { recursive: true });
for (const [from, to] of [
  ["codex-rs/ext/web-search/web_run_description.md", "web_run_description.md"],
  ["LICENSE", "CODEX-LICENSE"], ["NOTICE", "CODEX-NOTICE"],
]) copyFileSync(resolve(checkout, from), resolve(root, "src/vendor", to));
console.log(`Updated offline reference fixture and description from ${commit}`);
