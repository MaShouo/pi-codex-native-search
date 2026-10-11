import { setTimeout as delay } from "node:timers/promises";
import { parseSearchResponse, type SearchRequest, type SearchResponse } from "./schema.js";

export interface ModelIdentity { provider?: unknown; api?: unknown }
export function isOpenAIResponsesModel(model: ModelIdentity | undefined): boolean {
  // Keep identical to ~/.pi/agent/extensions/openai-responses-instructions.ts.
  return typeof model?.provider === "string" &&
    (/^openai(?:[-_]|$)/i.test(model.provider) || model.provider === "responses-websocket") &&
    model.api === "openai-responses";
}
export function resolveSearchUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Search requires an HTTP(S) provider base URL without embedded credentials or fragment.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/responses")) path = path.slice(0, -"/responses".length);
  if (url.hostname === "chatgpt.com" && path === "/backend-api") path += "/codex";
  url.pathname = `${path}/alpha/search`;
  return url.toString();
}
type HeaderValues = Record<string, string | null>;
export function searchHeaders(apiKey: string | undefined, modelHeaders?: HeaderValues, authHeaders?: HeaderValues): Headers {
  const headers = new Headers({
    "Content-Type": "application/json", "Accept": "application/json",
    "Originator": "pi-codex-native-search", "User-Agent": "pi-codex-native-search/0.1.0",
  });
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  // Match Pi provider header precedence, including explicit deletion.
  for (const layer of [modelHeaders, authHeaders]) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
  }
  for (const name of ["OpenAI-Beta", "Session_ID", "Conversation_ID", "X-Codex-Beta-Features", "X-Codex-Turn-State",
    "x-openai-internal-codex-responses-lite", "Content-Length", "Host", "Connection", "Transfer-Encoding", "Upgrade"]) headers.delete(name);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  return headers;
}

export interface TransportOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}
class ResponseLimitError extends Error {}
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    await response.body?.cancel();
    throw new ResponseLimitError("Codex search response exceeds the byte limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ResponseLimitError("Codex search response exceeds the byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
function retryDelay(response: Response | undefined, attempt: number, random: () => number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.floor(200 * 2 ** attempt * (0.9 + random() * 0.2));
}

// Official default: initial request + four retries, transport/5xx only, no 429 retry.
// Never follow redirects with provider credentials, never fall back to Responses.
export async function requestSearch(url: string, headers: Headers, request: SearchRequest, options: TransportOptions = {}): Promise<SearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Codex search timed out.")), options.timeoutMs ?? 60_000);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }));
  const body = JSON.stringify(request);
  try {
    for (let attempt = 0; attempt <= 4; attempt++) {
      signal.throwIfAborted();
      let response: Response | undefined;
      let responseText: string | undefined;
      try {
        response = await fetchImpl(url, { method: "POST", headers, body, signal, redirect: "manual" });
        signal.throwIfAborted();
        if (response.ok) responseText = await readBounded(response, options.maxResponseBytes ?? 8 * 1024 * 1024, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ResponseLimitError) throw error;
        if (attempt === 4) throw new Error("Codex search transport failed after five attempts.");
        await sleep(retryDelay(undefined, attempt, options.random ?? Math.random), signal);
        continue;
      }
      if (!response.ok) {
        // Do not copy arbitrary server errors, tokens, headers or URLs into the transcript.
        await response.body?.cancel();
        if (response.status >= 500 && response.status <= 599 && attempt < 4) {
          await sleep(retryDelay(response, attempt, options.random ?? Math.random), signal);
          continue;
        }
        throw new Error(`Codex alpha/search failed (HTTP ${response.status}); no Responses fallback was attempted.`);
      }
      let payload: unknown;
      try { payload = JSON.parse(responseText!); }
      catch { throw new Error("Codex search returned invalid JSON."); }
      return parseSearchResponse(payload);
    }
    throw new Error("Codex search retry limit reached.");
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Codex search cancelled.");
    if (controller.signal.aborted) throw new Error("Codex search timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
