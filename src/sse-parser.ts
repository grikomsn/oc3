// Line-oriented SSE parser tolerant of CRLF, multi-line data fields, and a
// final unterminated block (opencodex openaiChatEofTolerance / openai-oauth
// ResponsesStreamParser.finish() pattern).

export interface SseBlock {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): SseBlock[] {
    // A trailing CR may be the first half of a CRLF split across chunks, so it stays buffered.
    const text = this.buffer + chunk;
    const held = text.endsWith("\r") ? "\r" : "";
    this.buffer = normalizeLineEndings(text.slice(0, text.length - held.length)) + held;
    const blocks: SseBlock[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const block = parseBlock(this.buffer.slice(0, boundary));
      if (block) blocks.push(block);
      this.buffer = this.buffer.slice(boundary + 2);
    }
    return blocks;
  }

  finish(): SseBlock[] {
    const tail = normalizeLineEndings(this.buffer);
    this.buffer = "";
    const block = parseBlock(tail);
    return block ? [block] : [];
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function parseBlock(block: string): SseBlock | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return undefined;
  return { event, data };
}
