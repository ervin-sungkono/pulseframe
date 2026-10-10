import { useEffect, useState } from "react";
import { Check, Palette, Sparkles } from "lucide-react";
import type { VisualSettings } from "@/lib/visual-settings-model";
import {
  keyedPaletteResult,
  sampleImagePalette,
  type ImagePaletteSuggestion,
  type KeyedPaletteSuggestion,
} from "@/lib/image-palette";

type Props = {
  image: CanvasImageSource | null;
  imageKey: string | number | null;
  currentSettings: VisualSettings;
  onApply: (suggestion: ImagePaletteSuggestion) => void;
  label?: string;
};

type ImageBoundSuggestion = KeyedPaletteSuggestion & { sourceImage: CanvasImageSource };
type PaletteAnalysis = {
  sourceImage: CanvasImageSource;
  sourceKey: string | number;
  suggestions: ImageBoundSuggestion[];
  error: string;
};

/** Bounded local color suggestions. One click produces one palette change for the caller's undo history. */
export function ArtworkPalette({
  image,
  imageKey,
  currentSettings,
  onApply,
  label = "Artwork",
}: Props) {
  const [analysis, setAnalysis] = useState<PaletteAnalysis | null>(null);
  const currentAnalysis =
    analysis?.sourceImage === image && analysis.sourceKey === imageKey ? analysis : null;
  const activeResults = currentAnalysis?.suggestions ?? [];
  const busy = Boolean(image && imageKey !== null && !currentAnalysis);
  const error = currentAnalysis?.error ?? "";

  useEffect(() => {
    if (!image || imageKey === null) {
      const timer = window.setTimeout(() => setAnalysis(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const suggestions = sampleImagePalette(image);
        if (cancelled) return;
        const results = suggestions.map((suggestion) => ({
          ...keyedPaletteResult(imageKey, suggestion),
          sourceImage: image,
        }));
        setAnalysis({
          sourceImage: image,
          sourceKey: imageKey,
          suggestions: results,
          error: suggestions.length
            ? ""
            : "This image is fully transparent, so it has no colors to sample.",
        });
      } catch {
        if (!cancelled)
          setAnalysis({
            sourceImage: image,
            sourceKey: imageKey,
            suggestions: [],
            error: "Could not sample colors from this image. Your current colors were kept.",
          });
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [image, imageKey]);

  const apply = (result: ImageBoundSuggestion) => {
    if (result.sourceKey !== imageKey || result.sourceImage !== image) return;
    onApply(result.suggestion);
  };

  return (
    <section className="artwork-palette" aria-label={`${label} color suggestions`}>
      <div className="artwork-palette-heading">
        <div className="artwork-palette-mark">
          <Palette size={15} />
        </div>
        <div>
          <strong>Pull colors from {label.toLocaleLowerCase()}</strong>
          <p>Suggestions stay on this device. Choose one to change your colors.</p>
        </div>
      </div>
      {busy && <p className="artwork-palette-status">Sampling a small image preview…</p>}
      {!busy && !image && (
        <p className="artwork-palette-status">
          Add artwork or a background to see color suggestions.
        </p>
      )}
      {!busy && error && (
        <p className="artwork-palette-error" role="status">
          {error}
        </p>
      )}
      {activeResults.length > 0 && (
        <div className="artwork-palette-options">
          {activeResults.map((result) => {
            const { suggestion } = result;
            const colors = suggestion.colors;
            const isCurrent =
              colors.primary.toLowerCase() === currentSettings.primary.toLowerCase() &&
              colors.secondary.toLowerCase() === currentSettings.secondary.toLowerCase() &&
              colors.background.toLowerCase() === currentSettings.background.toLowerCase();
            return (
              <button
                type="button"
                className="artwork-palette-option"
                key={`${result.sourceKey}-${suggestion.id}`}
                aria-label={`Apply ${suggestion.label} colors`}
                aria-pressed={isCurrent}
                onClick={() => apply(result)}
              >
                <span
                  className="artwork-palette-preview"
                  style={{ backgroundColor: colors.background, color: colors.infoColor }}
                >
                  <span className="artwork-palette-wave" style={{ color: colors.primary }}>
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span
                    className="artwork-palette-preview-copy"
                    style={{ color: colors.infoColor }}
                  >
                    <b>Artist name</b>
                    <small style={{ color: colors.infoSecondaryColor }}>Release title</small>
                  </span>
                  <span className="artwork-palette-dot" style={{ background: colors.secondary }} />
                </span>
                <span className="artwork-palette-option-label">
                  {isCurrent ? <Check size={14} /> : <Sparkles size={13} />}
                  {suggestion.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
