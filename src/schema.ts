import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// Ported from openai/codex cc7ba33601286a751477832b01de7b6f8de0dd9c,
// codex-rs/codex-api/src/search.rs. See THIRD_PARTY_NOTICES.md.
const text = (description: string) => Type.String({ description });
const uint = (description: string) => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description });
const enumeration = <const T extends readonly string[]>(values: T, description: string) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
const optional = Type.Optional;
const query = Type.Object({
  q: text("Search query."),
  recency: optional(uint("Whether to filter by recency, as a number of recent days.")),
  domains: optional(Type.Array(Type.String(), { description: "Whether to filter by a specific list of domains." })),
});

export const CommandsSchema = Type.Object({
  search_query: optional(Type.Array(query, { description: "Query the internet search engine for a given list of queries." })),
  image_query: optional(Type.Array(query, { description: "Query the image search engine for a given list of queries." })),
  open: optional(Type.Array(Type.Object({
    ref_id: text("Reference id or URL to open."),
    lineno: optional(uint("Line number to position the page at.")),
  }), { description: "Open pages by reference id or URL." })),
  click: optional(Type.Array(Type.Object({
    ref_id: text("Reference id containing the numbered link."),
    id: uint("Numbered link id to open."),
  }), { description: "Open links from previously opened pages." })),
  find: optional(Type.Array(Type.Object({
    ref_id: text("Reference id or URL to search within."),
    pattern: text("Text pattern to find."),
  }), { description: "Find text patterns in pages." })),
  screenshot: optional(Type.Array(Type.Object({
    ref_id: text("Reference id or URL to screenshot."),
    pageno: uint("Zero-indexed PDF page number."),
  }), { description: "Take screenshots of PDF pages." })),
  finance: optional(Type.Array(Type.Object({
    ticker: text("Ticker symbol to look up."),
    type: enumeration(["equity", "fund", "crypto", "index"], "Asset type to look up."),
    market: optional(text('ISO 3166-1 alpha-3 country code, "OTC", or "" for cryptocurrency.')),
  }), { description: "Look up prices for the given stock symbols." })),
  weather: optional(Type.Array(Type.Object({
    location: text('Location in "Country, Area, City" format.'),
    start: optional(text("Start date in YYYY-MM-DD format. Defaults to today.")),
    duration: optional(uint("Number of days to return. Defaults to 7.")),
  }), { description: "Look up weather forecasts." })),
  sports: optional(Type.Array(Type.Object({
    tool: optional(enumeration(["sports"], "Tool name for sports requests.")),
    fn: enumeration(["schedule", "standings"], "Sports function to call."),
    league: enumeration(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"], "League to look up."),
    team: optional(text("Team to look up, using the common 3 or 4 letter alias used in broadcasts.")),
    opponent: optional(text("Opponent to use with `team` when narrowing the lookup.")),
    date_from: optional(text("Start date in YYYY-MM-DD format.")),
    date_to: optional(text("End date in YYYY-MM-DD format.")),
    num_games: optional(uint("Number of games to return.")),
    locale: optional(text("Locale for the lookup.")),
  }), { description: "Look up sports schedules and standings." })),
  time: optional(Type.Array(Type.Object({
    utc_offset: text('UTC offset formatted like "+03:00".'),
  }), { description: "Get time for the given UTC offsets." })),
  response_length: optional(enumeration(["short", "medium", "long"], "Set the length of the response to be returned.")),
});
export type SearchCommands = Static<typeof CommandsSchema>;

// Codex's JsonSchema serialization omits numeric bounds and format annotations.
// Keep runtime uint validation while sending the same uncompacted wire schema.
function wireSchema(schema: unknown): Record<string, unknown> {
  if (!isObject(schema)) throw new Error("Expected an object schema.");
  const result = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete result.minimum;
  delete result.maximum;
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>)
      .map(([key, child]) => [key, wireSchema(child)]));
    if (Array.isArray(result.required)) result.required = [...result.required].sort();
  }
  if (schema.items) result.items = wireSchema(schema.items);
  return result;
}
export const COMMANDS_WIRE_SCHEMA = wireSchema(CommandsSchema);

// Serde ignores unknown fields rather than forwarding arbitrary request keys.
function knownFields(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) throw new Error("Expected an object schema.");
  if (schema.type === "object" && isObject(value)) {
    return Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>)
      .filter(([key]) => value[key] !== undefined)
      .map(([key, child]) => [key, knownFields(value[key], child)]));
  }
  if (schema.type === "array" && Array.isArray(value)) return value.map((item) => knownFields(item, schema.items));
  return value;
}
export function parseCommands(value: unknown): SearchCommands {
  if (!Check(CommandsSchema, value)) throw new Error("Invalid web.run commands; expected the Codex SearchCommands schema.");
  return knownFields(value, CommandsSchema) as SearchCommands;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SearchSettings {
  user_location?: { type: "approximate"; country?: string; region?: string; city?: string; timezone?: string };
  search_context_size?: "low" | "medium" | "high";
  filters?: { allowed_domains?: string[]; blocked_domains?: string[] };
  image_settings?: { max_results?: number; caption?: boolean };
  allowed_callers?: ("direct" | "shell" | "code_interpreter")[];
  external_web_access?: boolean | "cached" | "indexed" | "live";
}
export interface SearchMessage {
  type: "message";
  role: "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
}
export interface SearchRequest {
  id: string;
  model: string;
  input?: string | SearchMessage[];
  commands?: SearchCommands;
  settings?: SearchSettings;
  max_output_tokens?: number;
}
export interface SearchResponse {
  output: string;
  results?: unknown[] | null;
  encrypted_output?: string | null;
}
export function parseSearchResponse(value: unknown): SearchResponse {
  if (!isObject(value) || typeof value.output !== "string" ||
      (value.results != null && !Array.isArray(value.results)) ||
      (value.encrypted_output != null && typeof value.encrypted_output !== "string")) {
    throw new Error("Invalid Codex search response: expected plaintext output and optional results array.");
  }
  return { output: value.output, ...(value.results !== undefined ? { results: value.results as unknown[] | null } : {}),
    ...(value.encrypted_output !== undefined ? { encrypted_output: value.encrypted_output as string | null } : {}) };
}
