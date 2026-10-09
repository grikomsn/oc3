import { describe, expect, test } from "bun:test";
import { SseParser, type SseBlock } from "../src/sse-parser";

function parseChunks(chunks: string[]): SseBlock[] {
  const parser = new SseParser();
  const blocks = chunks.flatMap((chunk) => parser.push(chunk));
  return [...blocks, ...parser.finish()];
}

describe("SseParser", () => {
  test("handles CRLF and multi-line data", () => {
    const parser = new SseParser();
    const blocks = parser.push('event: response.created\r\ndata: {"type":"a"}\r\n\r\ndata: {"type":"b"}\n\n');
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0]!.data).type).toBe("a");
  });

  test("reads the event field and joins multi-line data", () => {
    const blocks = parseChunks(['event: response.output_text.delta\r\ndata: {"delta":\r\ndata: "hi"}\r\n\r\n']);
    expect(blocks).toEqual([{ event: "response.output_text.delta", data: '{"delta":\n"hi"}' }]);
  });

  test("treats a lone CR as a line ending", () => {
    expect(parseChunks(["event: a\rdata: 1\r\rdata: 2\r\r"])).toEqual([
      { event: "a", data: "1" },
      { event: undefined, data: "2" },
    ]);
  });

  test("keeps a CRLF pair together when it is split across chunks at every offset", () => {
    const stream = 'event: response.created\r\ndata: {"type":"a"}\r\n\r\nevent: response.completed\r\ndata: {"type":"b"}\r\n\r\n';
    const expected = parseChunks([stream]);
    expect(expected.map((block) => block.event)).toEqual(["response.created", "response.completed"]);
    for (let offset = 0; offset <= stream.length; offset += 1) {
      expect(parseChunks([stream.slice(0, offset), stream.slice(offset)])).toEqual(expected);
    }
  });

  test("parses a CRLF stream delivered one character at a time", () => {
    const stream = 'data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n';
    expect(parseChunks([...stream]).map((block) => block.data)).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  test("flushes a final unterminated block", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"type":"x"}\n\n')).toHaveLength(1);
    expect(parser.push("data: {\"type\":\"y\"}")).toHaveLength(0);
    const tail = parser.finish();
    expect(tail).toHaveLength(1);
    expect(JSON.parse(tail[0]!.data).type).toBe("y");
    expect(parser.finish()).toHaveLength(0);
  });
});
