"use client";

import { useMemo, useState } from "react";
import type { PreparedSound } from "@/lib/audio-features";
import { CLIP_LENGTHS, suggestClips, type ClipLength } from "@/lib/clip-suggestions";
import { timestamp } from "./export-dialog";

export function ClipSuggestions({
  sound,
  duration,
  onSelectRange,
  onPreviewRange,
}: {
  sound: PreparedSound | null;
  duration: number;
  onSelectRange: (range: [number, number]) => void;
  onPreviewRange?: (range: [number, number]) => void;
}) {
  const [lengths, setLengths] = useState<ClipLength[]>([...CLIP_LENGTHS]);
  const result = useMemo(() => suggestClips(sound, duration, lengths), [sound, duration, lengths]);

  const toggleLength = (length: ClipLength) => {
    setLengths((current) =>
      current.includes(length)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== length)
        : [...current, length].sort((a, b) => a - b),
    );
  };

  return (
    <section
      aria-label="Promotional clip suggestions"
      className="subtitle-block"
      style={{ gap: 10 }}
    >
      <div>
        <strong style={{ display: "block", marginBottom: 4 }}>Clip suggestions</strong>
        <span style={{ color: "#a6b4ca", fontSize: 12, lineHeight: 1.45 }}>
          Suggestions use prepared audio activity and bass returns. They are starting points, not
          chorus detection.
        </span>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }} aria-label="Suggestion lengths">
        {CLIP_LENGTHS.map((length) => (
          <button
            key={length}
            type="button"
            className={`button ${lengths.includes(length) ? "button-soft" : ""}`}
            aria-pressed={lengths.includes(length)}
            onClick={() => toggleLength(length)}
          >
            {length} sec
          </button>
        ))}
      </div>
      {result.unavailableReason && (
        <p className="subtitle-warning" role="status">
          {result.unavailableReason}
        </p>
      )}
      {result.suggestions.map((suggestion, index) => (
        <article
          key={suggestion.id}
          style={{ display: "grid", gap: 7, padding: "10px 0", borderTop: "1px solid #36435a" }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "baseline",
            }}
          >
            <strong>
              Suggestion {index + 1} · {suggestion.reason}
            </strong>
            <span style={{ color: "#aebbd0", fontSize: 12 }}>
              {timestamp(suggestion.range[0], true)}–{timestamp(suggestion.range[1], true)}
            </span>
          </div>
          <span style={{ color: "#8f9db2", fontSize: 11 }}>
            {suggestion.length < suggestion.requestedLength
              ? `${suggestion.length.toFixed(1)} sec (track is shorter than ${suggestion.requestedLength} sec)`
              : `${suggestion.requestedLength} sec`}
          </span>
          <div style={{ display: "flex", gap: 7 }}>
            {onPreviewRange && (
              <button
                className="button button-soft"
                type="button"
                onClick={() => onPreviewRange(suggestion.range)}
              >
                Preview range
              </button>
            )}
            <button
              className="button button-soft"
              type="button"
              onClick={() => onSelectRange(suggestion.range)}
            >
              Use this range
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
