import type { Plugin } from "vite";
import { GEMINI_MAX_REQUEST_BYTES } from "./gemini-contract";

const BODY_READ_TIMEOUT_MS = 10_000;

/** Run the same Web handler locally; production uses the Vercel Function. */
export function lyricsDevApi(options: { bodyReadTimeoutMs?: number } = {}): Plugin {
  return {
    name: "pulseframe-lyrics-api",
    configureServer(server) {
      server.middlewares.use("/api/lyrics/transcribe", async (incoming, outgoing) => {
        const abort = new AbortController();
        incoming.once("aborted", () => abort.abort());
        outgoing.once("close", () => {
          if (!outgoing.writableFinished) abort.abort();
        });
        try {
          let timedOut = false;
          const bodyRead = (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of incoming) {
              if (timedOut) continue;
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > GEMINI_MAX_REQUEST_BYTES) return null;
              chunks.push(bytes);
            }
            return Buffer.concat(chunks);
          })();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<{ timedOut: true }>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              resolve({ timedOut: true });
            }, options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS);
          });
          const result = await Promise.race([
            bodyRead.then((body) => ({ timedOut: false as const, body })),
            deadline,
          ]).finally(() => {
            if (timeout !== undefined) clearTimeout(timeout);
          });
          if (result.timedOut) {
            abort.abort();
            outgoing.writeHead(408, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store, max-age=0",
              Pragma: "no-cache",
            });
            outgoing.end(
              JSON.stringify({
                error: {
                  code: "invalid_request",
                  message: "This audio request timed out while being received.",
                  retryable: false,
                },
                providerAttempts: 0,
              }),
            );
            const closeIncoming = () => incoming.destroy();
            if (outgoing.writableFinished) closeIncoming();
            else outgoing.once("finish", closeIncoming);
            return;
          }
          if (result.body === null) {
            outgoing.writeHead(413, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store, max-age=0",
              Pragma: "no-cache",
            });
            outgoing.end(
              JSON.stringify({
                error: {
                  code: "invalid_request",
                  message: "This audio request is too large.",
                  retryable: false,
                },
                providerAttempts: 0,
              }),
            );
            return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const method = incoming.method ?? "GET";
          const request = new Request(
            `http://${incoming.headers.host ?? "localhost"}/api/lyrics/transcribe`,
            {
              method,
              headers,
              signal: abort.signal,
              ...(method === "GET" || method === "HEAD" ? {} : { body: result.body }),
            },
          );
          const handler = await server.ssrLoadModule("/api/lyrics/transcribe.ts");
          const response: Response = await handler.default.fetch(request);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          if (!outgoing.headersSent)
            outgoing.writeHead(500, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store, max-age=0",
              Pragma: "no-cache",
            });
          outgoing.end(
            JSON.stringify({
              error: {
                code: "server_error",
                message: "The Gemini request could not be processed.",
              },
              providerAttempts: 0,
            }),
          );
        }
      });
    },
  };
}
