import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOpenAIResponsesModel, requestSearch, resolveSearchUrl, searchHeaders, type TransportOptions } from "./client.js";
import { recentInput } from "./history.js";
import { readOptions } from "./options.js";
import { CommandsSchema, parseCommands, type SearchRequest } from "./schema.js";
import { adaptProviderRequest, TOOL_NAME, WEB_DESCRIPTION } from "./wire.js";

export interface SearchDetails {
  sessionId: string;
  provider: string;
  model: string;
  results?: unknown[] | null;
  fullOutputPath?: string;
}

// Dependency injection is for offline tests. No I/O/auth/model discovery at load.
export function createExtension(transport: TransportOptions = {}) {
  return function codexNativeSearch(pi: ExtensionAPI): void {
    pi.registerFlag("codex-search-mode", { description: "Standalone search: disabled, cached (Codex default), indexed, live", type: "string", default: "cached" });
    pi.registerFlag("codex-search-max-output-tokens", { description: "Standalone search output token budget (Codex catalog default: 10000)", type: "string", default: "10000" });
    pi.registerFlag("codex-search-settings", { description: "Optional JSON Codex SearchSettings overrides", type: "string", default: "{}" });

    const tool = {
      name: TOOL_NAME,
      label: "Codex Web",
      description: WEB_DESCRIPTION,
      parameters: CommandsSchema,
      namespace: { name: "web", description: "Tools in the web namespace." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async execute(_id: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        signal?.throwIfAborted();
        const model = ctx.model;
        if (!model || !isOpenAIResponsesModel(model)) throw new Error("web.run requires an eligible OpenAI Responses provider (same rule as openai-responses-instructions).");
        const options = readOptions((name) => pi.getFlag(name));
        if (!options.enabled) throw new Error("Codex search is disabled.");
        const commands = parseCommands(params);
        const sessionId = ctx.sessionManager.getSessionId();
        // Snapshot branch context before asynchronous credential resolution.
        const input = recentInput(ctx.sessionManager.buildSessionProjection().messages);
        let auth;
        try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
        catch { throw new Error("Unable to resolve search credentials from the current Pi provider."); }
        signal?.throwIfAborted();
        if (!auth.ok) throw new Error("Unable to resolve search credentials; check the current Pi provider authentication.");
        // Auth-resolved baseUrl and auth headers stay paired; never route a gateway key to OpenAI.
        const url = resolveSearchUrl(auth.baseUrl ?? model.baseUrl);
        const headers = searchHeaders(auth.apiKey, model.headers, auth.headers);
        const request: SearchRequest = {
          id: sessionId, model: model.id, ...(input ? { input } : {}), commands,
          settings: options.settings, max_output_tokens: options.maxOutputTokens,
        };
        const response = await requestSearch(url, headers, request, { ...transport, signal });
        const details: SearchDetails = { sessionId, provider: model.provider, model: model.id,
          ...(response.results !== undefined ? { results: response.results } : {}) };
        // Normal output is unchanged, as in Codex. Only oversize Pi results spill to disk.
        const bounded = truncateHead(response.output);
        let output = bounded.content;
        if (bounded.truncated) {
          const directory = await mkdtemp(join(tmpdir(), "pi-codex-search-"));
          details.fullOutputPath = join(directory, "output.txt");
          await writeFile(details.fullOutputPath, response.output, { encoding: "utf8", mode: 0o600 });
          output += "\n\n[Output truncated by Pi. Full search output: " + details.fullOutputPath + "]";
        }
        return { content: [{ type: "text" as const, text: output }], details };
      },
    };
    pi.registerTool({ ...tool, exposure: "hidden" });
    let available = false;
    let activateOnReturn = true;
    const syncAvailability = (ctx: ExtensionContext) => {
      const next = isOpenAIResponsesModel(ctx.model) && readOptions((name) => pi.getFlag(name)).enabled;
      if (next === available) return;
      if (available) activateOnReturn = pi.getActiveTools().includes(TOOL_NAME);
      available = next;
      pi.registerTool({ ...tool, exposure: next ? "direct" : "hidden", defaultActive: activateOnReturn });
    };
    pi.on("session_start", (_event, ctx) => syncAvailability(ctx));
    pi.on("model_select", (_event, ctx) => syncAvailability(ctx));
    pi.on("before_agent_start", (_event, ctx) => syncAvailability(ctx));
    pi.on("before_provider_request", (event, ctx) => {
      if (isOpenAIResponsesModel(ctx.model)) return adaptProviderRequest(event.payload);
    });
    pi.on("message_end", (event) => {
      const message = event.message;
      if (message.role !== "assistant" || !isOpenAIResponsesModel(message)) return;
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "toolCall" || part.namespace !== "web" || part.name !== "run") return part;
        changed = true;
        return { ...part, name: TOOL_NAME };
      });
      if (changed) return { message: { ...message, content } };
    });
  };
}
export default createExtension();
