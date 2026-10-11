import { isObject, type SearchMessage } from "./schema.js";

// Codex utils/string/src/truncate.rs: ceil(UTF-8 bytes / 4), retain both ends.
export function truncateTokens(text: string, tokens: number): string {
  const bytes = Buffer.from(text);
  const budget = tokens * 4;
  if (bytes.length <= budget) return text;
  let left = Math.floor(budget / 2);
  let right = bytes.length - (budget - left);
  while (left > 0 && (bytes[left]! & 0xc0) === 0x80) left--;
  while (right < bytes.length && (bytes[right]! & 0xc0) === 0x80) right++;
  return bytes.subarray(0, left).toString() +
    `…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…` + bytes.subarray(right).toString();
}

// Port of ext/web-search/src/history.rs and tools/src/response_history.rs.
// The Pi adapter keeps actual user/assistant text, not thinking, tools, images,
// system prompts, custom extension messages or other session branches.
export function recentInput(messages: readonly unknown[]): SearchMessage[] | undefined {
  let visible: SearchMessage[] = [];
  for (const message of messages) {
    if (!isObject(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(parts)) continue;
    const content = parts.filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => ({ type: message.role === "user" ? "input_text" as const : "output_text" as const, text: part.text as string }));
    if (content.length) visible.push({ type: "message", role: message.role, content });
  }
  const users = visible.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (!users.length) return undefined;
  visible = visible.slice(users[Math.max(0, users.length - 2)]!, users.at(-1)! + 1);
  let remaining = 1000;
  for (const message of visible) {
    if (message.role !== "assistant") continue;
    message.content = message.content.filter((part) => {
      if (remaining === 0) return false;
      const tokens = Math.ceil(Buffer.byteLength(part.text) / 4);
      if (tokens > remaining) part.text = truncateTokens(part.text, remaining);
      remaining = Math.max(0, remaining - tokens);
      return true;
    });
  }
  return visible.filter((message) => message.content.length > 0);
}
