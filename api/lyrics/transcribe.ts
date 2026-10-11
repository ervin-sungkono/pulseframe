import { handleGeminiLyricsRequest } from "../../lib/lyrics/gemini-server.js";

/** Vercel's Node.js Web Request entry point preserves request cancellation and streamed body limits. */
export default {
  async fetch(request: Request) {
    try {
      return await handleGeminiLyricsRequest(request);
    } catch {
      return Response.json(
        {
          error: {
            code: "server_error",
            message: "The Gemini request could not be processed.",
          },
          providerAttempts: 0,
        },
        {
          status: 500,
          headers: {
            "cache-control": "no-store, max-age=0",
            pragma: "no-cache",
          },
        },
      );
    }
  },
};
