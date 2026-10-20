import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { lyricsDevApi } from "./lib/lyrics/dev-api";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "GEMINI_");
  for (const [name, value] of Object.entries(environment)) process.env[name] ??= value;
  const isolationHeaders = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
  };
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react(), lyricsDevApi()],
    resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
    worker: { format: "es" },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
  };
});
