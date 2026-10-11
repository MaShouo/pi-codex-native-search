import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isObject } from "./schema.js";

// Presentation only: content sent to the model and persisted details stay untouched.
export function displayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[^]*/g, (marker) => {
      const refs = marker.match(/turn\d+[a-z]+\d+/gi);
      return refs ? `[${refs.join(", ")}]` : "";
    });
}
const oneLine = (value: unknown) => displayText(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();

const commands: Record<string, { label: string; fields: string[] }> = {
  search_query: { label: "Search", fields: ["q"] },
  image_query: { label: "Images", fields: ["q"] },
  open: { label: "Open", fields: ["ref_id"] },
  click: { label: "Click", fields: ["ref_id", "id"] },
  find: { label: "Find", fields: ["pattern", "ref_id"] },
  screenshot: { label: "Screenshot", fields: ["ref_id", "pageno"] },
  finance: { label: "Finance", fields: ["ticker"] },
  weather: { label: "Weather", fields: ["location"] },
  sports: { label: "Sports", fields: ["league", "fn", "team"] },
  time: { label: "Time", fields: ["utc_offset"] },
};
export function callLines(args: unknown): string[] {
  if (!isObject(args)) return [];
  const lines: string[] = [];
  for (const [key, { label, fields }] of Object.entries(commands)) {
    const items = args[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isObject(item)) continue;
      const parts = fields.map((field) => typeof item[field] === "number" ? String(item[field]) : oneLine(item[field])).filter(Boolean);
      lines.push(`${label}  ${parts.join(" · ") || "…"}`);
    }
  }
  return lines;
}

interface SourcePreview { title: string; domain: string; summary: string }
export function sourcePreviews(output: string): SourcePreview[] {
  const sources: SourcePreview[] = [];
  const lines = displayText(output).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(.+?)\s+\((https?:\/\/\S+)\)\s*$/);
    if (!match) continue;
    let domain: string;
    try { domain = new URL(match[2]!).hostname; } catch { continue; }
    // The canonical output places metadata and the excerpt directly below the heading.
    const summary = (lines[i + 1] ?? "")
      .replace(/\[turn\d+[a-z]+\d+(?:, [^\]]+)?\]/gi, "")
      .replace(/\[wordlim:\s*\d+\]/gi, "")
      .replace(/(?:Published|Crawled|Content type):[^;\n]*;\s*/gi, "")
      .trim();
    sources.push({ title: oneLine(match[1]), domain, summary: oneLine(summary) });
  }
  return sources;
}

// Theme styling is evaluated during render, including after invalidate/theme changes.
function linesComponent(lines: () => string[], wrap = false): Component {
  return {
    render(width) {
      if (width <= 0) return [];
      const output = lines();
      const rendered = wrap ? new Text(output.join("\n"), 0, 0).render(width) : output;
      return rendered.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}

export const searchRenderers: ToolRenderers = {
  renderCall(args, theme, context) {
    const calls = callLines(args);
    return linesComponent(() => {
      const title = theme.fg("toolTitle", theme.bold("Web"));
      if (!calls.length) return [title + theme.fg("muted", "  Preparing request…")];
      const shown = context.expanded ? calls : calls.slice(0, 3);
      const lines = shown.map((call, i) => `${i === 0 ? title : "   "}  ${theme.fg("accent", call)}`);
      if (shown.length < calls.length) lines.push(theme.fg("muted", `     +${calls.length - shown.length} more operations · expand for details`));
      return lines;
    });
  },
  renderResult(result, options, theme, context) {
    const raw = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const clean = displayText(raw);
    const sources = sourcePreviews(raw);
    const details = isObject(result.details) ? result.details : {};
    return linesComponent(() => {
      if (context.isError) return [theme.fg("error", "Search failed"), theme.fg("error", clean || "Unknown error")];
      if (options.isPartial) return [theme.fg("muted", "Searching…")];
      const duration = typeof context.durationMs === "number" ? ` · ${(context.durationMs / 1000).toFixed(1)}s` : "";
      const heading = sources.length ? `${sources.length} ${sources.length === 1 ? "source" : "sources"}` : clean.trim() ? "Response received" : "No content returned";
      const lines = [theme.fg("muted", heading + duration)];
      if (options.expanded) {
        lines.push("", ...clean.split("\n").map((line) => theme.fg("toolOutput", line)));
      } else if (sources.length) {
        sources.slice(0, 3).forEach((source, i) => {
          lines.push(theme.fg("accent", `${i + 1}. ${source.title}`) + theme.fg("dim", ` · ${source.domain}`));
          if (source.summary) lines.push(theme.fg("muted", `   ${source.summary}`));
        });
        lines.push(theme.fg("dim", sources.length > 3 ? `+${sources.length - 3} more sources · expand for details` : "Expand for full content"));
      } else if (clean.trim()) {
        lines.push(...clean.split("\n").filter((line) => line.trim()).slice(0, 3).map((line) => theme.fg("toolOutput", line)));
        lines.push(theme.fg("dim", "Expand for full content"));
      }
      if (typeof details.fullOutputPath === "string") lines.push(theme.fg("warning", `Full output: ${oneLine(details.fullOutputPath)}`));
      return lines;
    }, options.expanded || context.isError);
  },
};
