import type { Socket } from "bun";
import { hostAllowed } from "./spec";

/**
 * The network allowlist proxy. A sandboxed command may only reach the loopback interface
 * (Seatbelt rule) and is handed HTTP(S)_PROXY pointing here; this forward proxy tunnels
 * CONNECT (TLS) and plain absolute-URI HTTP requests to allowlisted hosts and answers 403 for
 * everything else. Every denial is recorded with the host, so a run can report "the tests
 * tried to reach telemetry.example.com" rather than a bare connection error.
 *
 * Bytes are relayed untouched: TLS is not terminated, nothing is inspected beyond the request
 * line.
 */

export interface AllowlistProxy {
  port: number;
  /** http://127.0.0.1:<port> — the value for HTTP_PROXY / HTTPS_PROXY. */
  url: string;
  /** Hosts refused so far, in order, duplicates included (each attempt is an event). */
  denied: string[];
  close(): void;
}

interface ClientState {
  head: string;
  upstream: Socket<unknown> | null;
  connecting: boolean;
  pending: Buffer[];
}

const MAX_HEAD = 64 * 1024;

export function startAllowlistProxy(allow: string[], opts: { onDeny?: (host: string) => void } = {}): AllowlistProxy {
  const denied: string[] = [];
  const server = Bun.listen<ClientState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        sock.data = { head: "", upstream: null, connecting: false, pending: [] };
      },
      data(sock, chunk) {
        const st = sock.data;
        if (st.upstream) {
          st.upstream.write(chunk);
          return;
        }
        if (st.connecting) {
          st.pending.push(Buffer.from(chunk));
          return;
        }
        st.head += chunk.toString("latin1");
        const end = st.head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (st.head.length > MAX_HEAD) sock.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
          return;
        }
        const headText = st.head.slice(0, end);
        const rest = Buffer.from(st.head.slice(end + 4), "latin1");
        st.head = "";
        const requestLine = headText.split("\r\n")[0] ?? "";
        const [method = "", target = ""] = requestLine.split(" ");

        let host: string;
        let port: number;
        let forward: Buffer;
        if (method === "CONNECT") {
          [host, port] = splitHostPort(target, 443);
          forward = rest;
        } else {
          let url: URL;
          try {
            url = new URL(target);
          } catch {
            sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            return;
          }
          host = url.hostname;
          port = url.port ? Number(url.port) : 80;
          const rewritten = headText.replace(requestLine, `${method} ${url.pathname}${url.search} HTTP/1.1`);
          forward = Buffer.concat([Buffer.from(`${rewritten}\r\n\r\n`, "latin1"), rest]);
        }
        if (!host || !hostAllowed(host, allow)) {
          denied.push(host);
          opts.onDeny?.(host);
          sock.end(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n` +
              `sandbox: ${host || "(no host)"} is not in this HOP's network allowlist\n`,
          );
          return;
        }
        st.connecting = true;
        Bun.connect({
          hostname: host,
          port,
          socket: {
            open(up) {
              st.upstream = up;
              if (method === "CONNECT") sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
              if (forward.length) up.write(forward);
              for (const p of st.pending) up.write(p);
              st.pending = [];
            },
            data(_up, d) {
              sock.write(d);
            },
            close() {
              sock.end();
            },
            error() {
              sock.end();
            },
            connectError() {
              sock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            },
          },
        }).catch(() => sock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
      },
      close(sock) {
        sock.data?.upstream?.end();
      },
      error(sock) {
        sock.data?.upstream?.end();
      },
    },
  });
  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    denied,
    close: () => server.stop(true),
  };
}

function splitHostPort(target: string, defaultPort: number): [string, number] {
  // IPv6 literal: [::1]:443
  const m6 = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m6) return [m6[1]!, m6[2] ? Number(m6[2]) : defaultPort];
  const i = target.lastIndexOf(":");
  if (i < 0) return [target, defaultPort];
  const port = Number(target.slice(i + 1));
  return Number.isFinite(port) && port > 0 ? [target.slice(0, i), port] : [target, defaultPort];
}

/** Proxy variables for the sandboxed child. Both cases: curl, pip, node, git, uv, and Go
 *  disagree on which they read. NO_PROXY keeps loopback traffic direct (dev servers, local DBs). */
export function proxyEnv(proxy: AllowlistProxy): Record<string, string> {
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    all_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
