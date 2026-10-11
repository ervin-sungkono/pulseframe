import { z } from "zod";
import { MAX_SUBTITLE_TEXT_LENGTH } from "../subtitles.js";
import { MAX_LYRICS_DURATION_MS } from "./policy.js";
import { GEMINI_LANGUAGE_CODES } from "./gemini-languages.js";

/** Constants shared by Gemini audio preparation, the browser client, and the server route. */
export const GEMINI_SAMPLE_RATE = 16_000;
export const GEMINI_AUDIO_CHUNK_MS = 100_000;
export const GEMINI_AUDIO_OVERLAP_MS = 2_000;
export const GEMINI_AUDIO_STRIDE_MS = GEMINI_AUDIO_CHUNK_MS - GEMINI_AUDIO_OVERLAP_MS;
export const GEMINI_MAX_SOURCE_DURATION_MS = MAX_LYRICS_DURATION_MS;
export const GEMINI_MAX_CHUNK_COUNT =
  1 + Math.ceil((GEMINI_MAX_SOURCE_DURATION_MS - GEMINI_AUDIO_CHUNK_MS) / GEMINI_AUDIO_STRIDE_MS);
export const GEMINI_MAX_REQUEST_BYTES = 4_500_000;
export const GEMINI_MAX_WAV_BYTES = 44 + (GEMINI_SAMPLE_RATE * GEMINI_AUDIO_CHUNK_MS * 2) / 1000;
export const GEMINI_MAX_BASE64_CHARS = 4 * Math.ceil(GEMINI_MAX_WAV_BYTES / 3);
// Preserve the original allowance of two phrases per second when chunk sizes change.
export const GEMINI_MAX_SEGMENTS_PER_CHUNK = 2 * Math.ceil(GEMINI_AUDIO_CHUNK_MS / 1000);
export const GEMINI_MAX_SEGMENT_TEXT_LENGTH = MAX_SUBTITLE_TEXT_LENGTH;

export const geminiSegmentSchema = z
  .object({
    startMs: z.number().finite(),
    endMs: z.number().finite(),
    text: z.string().min(1).max(GEMINI_MAX_SEGMENT_TEXT_LENGTH),
  })
  .strict();

export const geminiSegmentsSchema = z.array(geminiSegmentSchema).max(GEMINI_MAX_SEGMENTS_PER_CHUNK);

export const geminiFlagsSchema = z.object({ uncertain: z.boolean(), timing: z.boolean() }).strict();

export const geminiTranscriptionRequestSchema = z
  .object({
    chunkIndex: z
      .number()
      .int()
      .min(0)
      .max(GEMINI_MAX_CHUNK_COUNT - 1),
    totalChunks: z.number().int().min(1).max(GEMINI_MAX_CHUNK_COUNT),
    chunkStartMs: z.number().finite().min(0).max(GEMINI_MAX_SOURCE_DURATION_MS),
    chunkDurationMs: z.number().finite().positive().max(GEMINI_AUDIO_CHUNK_MS),
    sourceDurationMs: z.number().finite().positive().max(GEMINI_MAX_SOURCE_DURATION_MS),
    preset: z.enum(["auto", "fast", "quality"]),
    recheck: z.boolean(),
    languageCode: z.string().refine((code) => GEMINI_LANGUAGE_CODES.has(code)),
    audioBase64: z.string().min(1).max(GEMINI_MAX_BASE64_CHARS),
  })
  .strict();

export const geminiProviderContentSchema = z
  .object({ segments: geminiSegmentsSchema, flags: geminiFlagsSchema })
  .strict();

export const geminiSuccessResponseSchema = geminiProviderContentSchema
  .extend({
    model: z.string().min(1).max(100),
    providerAttempts: z.number().int().nonnegative(),
    tokenUsage: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type GeminiTranscriptionRequest = z.infer<typeof geminiTranscriptionRequestSchema>;
export type GeminiProviderContent = z.infer<typeof geminiProviderContentSchema>;
export type GeminiSuccessResponse = z.infer<typeof geminiSuccessResponseSchema>;
