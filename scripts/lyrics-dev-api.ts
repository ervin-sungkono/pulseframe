import type { Plugin } from "vite";

/** Run the same Web handler locally; production uses the Vercel Function. */
export function lyricsDevApi(): Plugin {
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
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of incoming) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 4_100_000) {
              outgoing.writeHead(413, { "Content-Type": "application/json" });
              outgoing.end(JSON.stringify({ error: "Audio request is too large." }));
              return;
            }
            chunks.push(bytes);
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
              ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
            },
          );
          const handler = await server.ssrLoadModule("/api/lyrics/transcribe.ts");
          const response: Response = await handler.default.fetch(request);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          if (!outgoing.headersSent)
            outgoing.writeHead(500, { "Content-Type": "application/json" });
          outgoing.end(
            JSON.stringify({
              error: "The local transcription endpoint is unavailable.",
            }),
          );
        }
      });
    },
  };
}
