import { Type } from "typebox";
import { Check } from "typebox/value";
import type { SearchSettings } from "./schema.js";

const str = Type.Optional(Type.String());
const enumString = (values: string[]) => Type.Unsafe<string>({ type: "string", enum: values });
const SettingsSchema = Type.Object({
  user_location: Type.Optional(Type.Object({ type: enumString(["approximate"]), country: str, region: str, city: str, timezone: str }, { additionalProperties: false })),
  search_context_size: Type.Optional(enumString(["low", "medium", "high"])),
  filters: Type.Optional(Type.Object({ allowed_domains: Type.Optional(Type.Array(Type.String())), blocked_domains: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
  image_settings: Type.Optional(Type.Object({ max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), caption: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
  allowed_callers: Type.Optional(Type.Array(enumString(["direct", "shell", "code_interpreter"]))),
  external_web_access: Type.Optional(Type.Union([Type.Boolean(), enumString(["cached", "indexed", "live"])])),
}, { additionalProperties: false });
export interface SearchOptions { enabled: boolean; settings: SearchSettings; maxOutputTokens: number }
export function readOptions(getFlag: (name: string) => string | boolean | undefined): SearchOptions {
  const mode = getFlag("codex-search-mode") ?? "cached";
  if (!["disabled", "cached", "indexed", "live"].includes(String(mode))) throw new Error("codex-search-mode must be disabled, cached, indexed or live.");
  const maxOutputTokens = Number(getFlag("codex-search-max-output-tokens") ?? "10000");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("codex-search-max-output-tokens must be a positive safe integer.");
  let settings: unknown;
  try { settings = JSON.parse(String(getFlag("codex-search-settings") ?? "{}")); }
  catch { throw new Error("codex-search-settings must be a JSON SearchSettings object."); }
  if (!Check(SettingsSchema, settings)) throw new Error("Invalid codex-search-settings; see the SearchSettings fields in README.md.");
  return {
    enabled: mode !== "disabled", maxOutputTokens,
    settings: { allowed_callers: ["direct"], external_web_access: mode === "indexed" ? "indexed" : mode === "live", ...settings as SearchSettings },
  };
}
