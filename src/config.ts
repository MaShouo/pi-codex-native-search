import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readOptions, type SearchOptions } from "./options.js";
import { isObject } from "./schema.js";

export const SEARCH_MODES = ["live", "cached", "indexed", "disabled"] as const;
export type SearchMode = typeof SEARCH_MODES[number];
export const configPath = () => join(getAgentDir(), "codex-native-search.json");

function readConfig(path: string | null): Record<string, unknown> {
  if (path === null) return {};
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Unable to read Codex search config: ${path}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid JSON in Codex search config: ${path}`); }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => !["mode", "maxOutputTokens", "settings"].includes(key))) throw new Error("Codex search config accepts only mode, maxOutputTokens and settings.");
  if (parsed.mode !== undefined && !SEARCH_MODES.includes(parsed.mode as SearchMode)) throw new Error("Invalid mode in Codex search config.");
  if (parsed.maxOutputTokens !== undefined && (typeof parsed.maxOutputTokens !== "number" || !Number.isSafeInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens < 1)) throw new Error("Invalid maxOutputTokens in Codex search config.");
  if (parsed.settings !== undefined && !isObject(parsed.settings)) throw new Error("Codex search config settings must be an object.");
  return parsed;
}

// Read on demand, never at extension load. null isolates offline tests from user config.
export function configuredOptions(
  getFlag: (name: string) => string | boolean | undefined,
  path: string | null = configPath(),
): SearchOptions {
  const config = readConfig(path);
  const values: Record<string, string | undefined> = {
    "codex-search-mode": config.mode as string | undefined,
    "codex-search-max-output-tokens": config.maxOutputTokens === undefined ? undefined : String(config.maxOutputTokens),
    "codex-search-settings": config.settings === undefined ? undefined : JSON.stringify(config.settings),
  };
  // Validate file settings even when a CLI override is present, and never silently fall back.
  readOptions((name) => values[name]);
  if (getFlag("codex-search-mode") !== undefined && isObject(config.settings)) {
    const settings = { ...config.settings };
    delete settings.external_web_access;
    values["codex-search-settings"] = JSON.stringify(settings);
  }
  return readOptions((name) => getFlag(name) ?? values[name]);
}

export function effectiveMode(options: SearchOptions): SearchMode {
  if (!options.enabled) return "disabled";
  const value = options.settings.external_web_access;
  return value === "indexed" ? "indexed" : value === true || value === "live" ? "live" : "cached";
}

export function saveMode(mode: SearchMode, path: string = configPath()): void {
  if (!SEARCH_MODES.includes(mode)) throw new Error("Invalid search mode.");
  // Validate existing data before rewriting; malformed files are never overwritten.
  configuredOptions(() => undefined, path);
  const config = readConfig(path);
  config.mode = mode;
  // A saved low-level setting must not silently defeat the user's mode selection.
  if (isObject(config.settings)) delete config.settings.external_web_access;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch {
    throw new Error(`Unable to save Codex search config: ${path}`);
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed, or creation failed. */ }
  }
}
