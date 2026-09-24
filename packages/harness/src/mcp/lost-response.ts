import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Streamable-HTTP responses that never arrive.
 *
 * A hosted MCP server that wakes on request (or gets its pod recycled mid-call) can close the
 * POST's SSE stream before the JSON-RPC response is written. The SDK only resumes a stream the
 * server marked resumable (an SSE `id:` field); a stream that ends with no id and no response
 * is silently dropped, and the request then waits for its full timeout (10 minutes for tool
 * calls). Observed 2026-09-24 against the platform web-search server: the service logged
 * "Upstream SSE stream broke" one second after answering, and the client sat until killed.
 *
 * This fetch wrapper watches each POST that carries requests. When its SSE body ends (cleanly
 * or by error) without a response for one of those ids, and the server sent no resumption id,
 * it delivers a synthetic JSON-RPC error for the id, so the pending request rejects now with a
 * named cause instead of timing out.
 */

/** JSON-RPC error code for a stream that closed before the response; not an SDK code. */
export const LOST_RESPONSE_CODE = -32050;

export function isLostResponse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === LOST_RESPONSE_CODE;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

interface PendingRequest {
  id: string | number;
  method: string;
}

/** Wrap `base` so SSE bodies that end without their response report through `onLost`. */
export function lostResponseFetch(onLost: (message: JSONRPCMessage) => void, base: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const pending = init?.method === "POST" ? requestsIn(init.body) : [];
    const response = await base(input, init);
    if (pending.length === 0 || !response.body || !isEventStream(response.headers.get("content-type"))) return response;
    const body = watchStream(response.body, pending, onLost);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function requestsIn(body: RequestInit["body"]): PendingRequest[] {
  if (typeof body !== "string") return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.flatMap((m) => {
      const msg = m as { id?: string | number; method?: string };
      return typeof msg?.method === "string" && msg.id !== undefined ? [{ id: msg.id, method: msg.method }] : [];
    });
  } catch {
    return [];
  }
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

/** Pass the stream through untouched while tracking which request ids were answered. */
function watchStream(
  source: ReadableStream<Uint8Array>,
  pending: PendingRequest[],
  onLost: (message: JSONRPCMessage) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const answered = new Set<string>();
  let buffered = "";
  let resumable = false;

  const scan = (text: string) => {
    buffered += text;
    const events = buffered.split(/\r?\n\r?\n/);
    buffered = events.pop() ?? "";
    for (const event of events) {
      const data: string[] = [];
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith("id:") && line.slice(3).trim()) resumable = true;
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      try {
        const msg = JSON.parse(data.join("\n")) as { id?: string | number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && ("result" in msg || "error" in msg)) answered.add(String(msg.id));
      } catch {
        // Not JSON-RPC; the SDK reports it.
      }
    }
  };

  const settle = (cause: string) => {
    if (resumable) return; // the SDK reconnects and replays a resumable stream itself
    for (const req of pending) {
      if (answered.has(String(req.id))) continue;
      onLost({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: LOST_RESPONSE_CODE,
          message: `MCP response lost: the server closed the stream before answering ${req.method} (${cause})`,
        },
      });
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (e) {
        settle(`stream error: ${String((e as Error)?.message ?? e)}`);
        controller.error(e);
        return;
      }
      if (step.done) {
        scan(decoder.decode());
        settle("stream ended");
        controller.close();
        return;
      }
      scan(decoder.decode(step.value, { stream: true }));
      controller.enqueue(step.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
