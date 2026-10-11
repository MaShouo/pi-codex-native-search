import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOpenAIResponsesModel, requestSearch, resolveSearchUrl, searchHeaders, type TransportOptions } from "./client.js";
import { recentInput } from "./history.js";
import { configuredOptions, effectiveMode, saveMode, SEARCH_MODES, type SearchMode } from "./config.js";
import { searchRenderers } from "./render.js";
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
export function createExtension(transport: TransportOptions = {}, configurationPath?: string | null) {
  return function codexNativeSearch(pi: ExtensionAPI): void {
    pi.registerFlag("codex-search-mode", { description: "Override saved search mode: disabled, cached, indexed, live", type: "string" });
    pi.registerFlag("codex-search-max-output-tokens", { description: "Override saved search output token budget (default: 10000)", type: "string" });
    pi.registerFlag("codex-search-settings", { description: "Override saved Codex SearchSettings with JSON", type: "string" });
    const getOptions = () => configuredOptions((name) => pi.getFlag(name), configurationPath);

    const tool = {
      ...searchRenderers,
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
        const options = getOptions();
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
      const next = isOpenAIResponsesModel(ctx.model) && getOptions().enabled;
      if (next === available) return;
      if (available) activateOnReturn = pi.getActiveTools().includes(TOOL_NAME);
      available = next;
      pi.registerTool({ ...tool, exposure: next ? "direct" : "hidden", defaultActive: activateOnReturn });
    };
    pi.registerCommand("codex-search", {
      description: "Choose and save search mode: live, cached, indexed, disabled",
      getArgumentCompletions: (prefix) => SEARCH_MODES.filter((mode) => mode.startsWith(prefix.trim().toLowerCase())).map((mode) => ({ value: mode, label: mode })),
      handler: async (args, ctx) => {
        try {
          let choice = args.trim().toLowerCase();
          if (!choice) {
            const current = effectiveMode(getOptions());
            if (!ctx.hasUI) {
              ctx.ui.notify(`Search mode: ${current}. Usage: /codex-search live|cached|indexed|disabled`, "info");
              return;
            }
            const selected = await ctx.ui.select(`Codex search · ${current}`, [...SEARCH_MODES]);
            if (selected === undefined) return;
            choice = selected;
          }
          if (!SEARCH_MODES.includes(choice as SearchMode)) {
            ctx.ui.notify("Usage: /codex-search live|cached|indexed|disabled", "warning");
            return;
          }
          if (configurationPath === null) throw new Error("Persistent configuration is disabled in this test instance.");
          saveMode(choice as SearchMode, configurationPath);
          syncAvailability(ctx);
          const actual = effectiveMode(getOptions());
          const overridden = actual !== choice;
          ctx.ui.notify(overridden
            ? `Saved ${choice}; current mode is ${actual} due to CLI overrides. Restart without the overriding flags to use the saved mode.`
            : `Codex search: ${actual} · saved.`, overridden ? "warning" : "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Unable to change search mode.", "error");
        }
      },
    });
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
