import { readFileSync } from "node:fs";
import { COMMANDS_WIRE_SCHEMA, isObject } from "./schema.js";

export const TOOL_NAME = "web.run";
export const WEB_DESCRIPTION = readFileSync(new URL("./vendor/web_run_description.md", import.meta.url), "utf8");
export function namespaceTool(): Record<string, unknown> {
  return {
    type: "namespace", name: "web", description: "Tools in the web namespace.",
    tools: [{ type: "function", name: "run", description: WEB_DESCRIPTION, parameters: COMMANDS_WIRE_SCHEMA, strict: false }],
  };
}

// Pi stores executable dotted names; Codex's wire protocol separates name/namespace.
// Only rewrite our tool, without injecting a tool hidden by codemode/active-tools.
export function adaptProviderRequest(payload: unknown): Record<string, unknown> | undefined {
  if (!isObject(payload)) return undefined;
  const result = { ...payload };
  let changed = false;
  if (Array.isArray(payload.tools)) {
    const ownsDeclaration = payload.tools.some((tool) => isObject(tool) && tool.type === "function" && tool.name === TOOL_NAME);
    if (ownsDeclaration) {
      result.tools = payload.tools
        .filter((tool) => !isObject(tool) || (tool.type !== "web_search" && tool.type !== "web_search_preview"))
        .map((tool) => isObject(tool) && tool.type === "function" && tool.name === TOOL_NAME ? namespaceTool() : tool);
      changed = true;
    }
  }
  if (isObject(payload.tool_choice) && payload.tool_choice.type === "function" && payload.tool_choice.name === TOOL_NAME) {
    result.tool_choice = { ...payload.tool_choice, name: "run", namespace: "web" };
    changed = true;
  }
  if (Array.isArray(payload.input)) {
    const callIds = new Set(payload.input.filter((item) => isObject(item) && item.type === "function_call" &&
      (item.name === TOOL_NAME || (item.namespace === "web" && item.name === "run"))).map((item) => item.call_id));
    result.input = payload.input.map((item) => {
      if (!isObject(item)) return item;
      if (item.type === "function_call" && item.name === TOOL_NAME) {
        changed = true;
        return { ...item, name: "run", namespace: "web" };
      }
      if (item.type === "function_call_output" && callIds.has(item.call_id) && typeof item.output === "string") {
        changed = true;
        return { ...item, output: [{ type: "input_text", text: item.output }] };
      }
      return item;
    });
  }
  return changed ? result : undefined;
}
