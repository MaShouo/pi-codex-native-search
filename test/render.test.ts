import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { callLines, displayText, searchRenderers, sourcePreviews } from "../src/render.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;
const context = { expanded: false, isError: false, durationMs: 3200 } as any;
const raw = Array.from({ length: 5 }, (_, i) => `标题 ${i} (https://example.com/page${i})\nciteturn0search${i} [wordlim: 200] Crawled: today; Useful excerpt ${i}\n\nBody ${i}`).join("\n----------------------------------\n");
const result = { content: [{ type: "text" as const, text: raw }], details: { results: [{ type: "unknown" }] } };

test("search calls show readable operations including partial and mixed commands", () => {
  assert.deepEqual(callLines({ search_query: [{ q: "中文搜索" }], open: [{ ref_id: "turn0search0" }], find: [{ pattern: "needle", ref_id: "turn1view0" }] }), ["Search  中文搜索", "Open  turn0search0", "Find  needle · turn1view0"]);
  for (const args of [undefined, {}, { search_query: [null, {}, { q: "" }] }]) {
    assert.doesNotThrow(() => searchRenderers.renderCall!(args, theme, context).render(30));
  }
  const lines = searchRenderers.renderCall!({ search_query: Array.from({ length: 5 }, () => ({ q: "hello" })) }, theme, context).render(80);
  assert.equal(lines.length, 4);
  assert.match(lines.join("\n"), /\+2 more operations/);
});

test("compact source cards and expanded details preserve the model payload", () => {
  const before = structuredClone(result);
  assert.equal(sourcePreviews(raw).length, 5);
  const component = searchRenderers.renderResult!(result, { expanded: false, isPartial: false }, theme, context);
  const text = component.render(100).join("\n");
  assert.match(text, /5 sources · 3.2s/);
  assert.match(text, /标题 0 · example.com/);
  assert.match(text, /Useful excerpt 0/);
  assert.match(text, /\+2 more sources/);
  assert.doesNotMatch(text, /wordlim||turn0search|Body/);
  const expanded = searchRenderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context).render(100).join("\n");
  assert.match(expanded, /\[turn0search4\]/);
  assert.match(expanded, /Body 4/);
  assert.deepEqual(result, before);
});

test("rendering handles narrow widths, Unicode, ANSI injection, theme changes, errors and non-web outputs", () => {
  const dirty = '\x1b[31mred\x1b[0m\x1b]52;c;PAYLOAD\x07\r\n中文 😃';
  assert.doesNotMatch(displayText(dirty), /\x1b|PAYLOAD|\x07/);
  for (const width of [1, 2, 8, 20, 80]) {
    for (const expanded of [true, false]) {
      const component = searchRenderers.renderResult!(result, { expanded, isPartial: false }, theme, context);
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      assert.deepEqual(component.render(0), []);
    }
  }
  let color = "A";
  const changingTheme = { ...theme, fg: (_: string, text: string) => color + text };
  const dynamic = searchRenderers.renderCall!({}, changingTheme, context);
  assert.match(dynamic.render(80)[0]!, /AWeb/);
  color = "B"; dynamic.invalidate();
  assert.match(dynamic.render(80)[0]!, /BWeb/);
  const failure = searchRenderers.renderResult!({ content: [{ type: "text", text: "HTTP 403" }], details: undefined }, { expanded: false, isPartial: false }, theme, { ...context, isError: true }).render(80).join("\n");
  assert.match(failure, /Search failed\s+HTTP 403/);
  for (const output of ["", "Weather: sunny", "09:30 UTC+08:00", dirty]) {
    const lines = searchRenderers.renderResult!({ content: [{ type: "text", text: output }], details: undefined }, { expanded: false, isPartial: false }, theme, context).render(80);
    assert.ok(lines.length <= 5);
    assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /|PAYLOAD/);
  }
  const partial = searchRenderers.renderResult!(result, { expanded: false, isPartial: true }, theme, context).render(80).join("\n");
  assert.match(partial, /Searching/);
  const spilled = searchRenderers.renderResult!({ ...result, details: { fullOutputPath: "/tmp/output.txt" } }, { expanded: false, isPartial: false }, theme, context).render(100).join("\n");
  assert.match(spilled, /Full output: \/tmp\/output.txt/);
});
