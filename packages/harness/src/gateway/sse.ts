/**
 * Minimal SSE parser for the gateway's Anthropic-format stream. We dispatch on the
 * JSON `type` field inside each event's `data:` payload and ignore the `event:` line.
 * Carriage returns are stripped so \r\n framing collapses to \n\n boundaries.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEvent(block);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode().replace(/\r/g, "");
    const tail = parseEvent(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Parse one SSE block's data payload. Returns null for non-data blocks (keepalives,
 *  comments) and for malformed JSON — a single bad chunk must not kill the stream. */
function parseEvent(block: string): Record<string, unknown> | null {
  const data = extractData(block);
  if (data === null) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractData(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}
