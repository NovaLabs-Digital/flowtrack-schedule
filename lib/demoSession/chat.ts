// Guided Demo Session chat (migration 046): limits and text handling shared
// by the server route and the browser. Chat text is plain text only: line
// breaks and tabs are kept, every other control character is removed, and it
// is never rendered as HTML.
export const CHAT_MAX_CHARS = 500;
export function cleanChatText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > CHAT_MAX_CHARS * 4) return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return text.length >= 1 && [...text].length <= CHAT_MAX_CHARS ? text : null;
}
