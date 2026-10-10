"use client";

import { useState } from "react";
import {
  clampCompositionBounds,
  compositionSchema,
  setCompositionBounds,
  type Composition,
  type CompositionAspect,
  type CompositionBounds,
  type CompositionElement,
} from "@/lib/composition";
import type { VisualSettings } from "@/lib/visual-settings-model";

export type CompositionInspectorProps = {
  settings: VisualSettings;
  aspect: CompositionAspect;
  selectedElement: CompositionElement;
  bounds: CompositionBounds;
  onChange: (settings: VisualSettings) => void;
  disabled?: boolean;
};

function NumberControl({
  label,
  value,
  min = 0,
  max = 100,
  step = 0.1,
  suffix = "%",
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const scaledValue = value * (suffix === "%" ? 100 : 1);
  const formatted = String(Number(scaledValue.toFixed(1)));
  return (
    <label className="composition-number-control">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={focused ? draft : formatted}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onFocus={() => {
            setDraft(formatted);
            setFocused(true);
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => {
            const entered = Number(draft);
            if (Number.isFinite(entered) && Math.abs(entered - scaledValue) > 0.00001) {
              onCommit(Math.max(min, Math.min(max, entered)) / (suffix === "%" ? 100 : 1));
              setDraft(String(Number(Math.max(min, Math.min(max, entered)).toFixed(1))));
            } else setDraft(formatted);
            setFocused(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <small>{suffix}</small>
      </div>
    </label>
  );
}

export function CompositionInspector({
  settings,
  aspect,
  selectedElement,
  bounds,
  onChange,
  disabled = false,
}: CompositionInspectorProps) {
  const composition = compositionSchema.parse(settings.composition ?? {});
  const changeBounds = (key: keyof CompositionBounds, value: number) => {
    const nextBounds = clampCompositionBounds({ ...bounds, [key]: value / 100 });
    onChange({
      ...settings,
      composition: setCompositionBounds(composition, aspect, selectedElement, nextBounds),
    });
  };
  const patchComposition = (patch: Partial<Composition>) =>
    onChange({ ...settings, composition: compositionSchema.parse({ ...composition, ...patch }) });

  return (
    <section className="composition-inspector" aria-label={`${selectedElement} settings`}>
      <div className="composition-inspector-heading">
        <div>
          <span className="composition-inspector-eyebrow">Selected element</span>
          <h3>
            {selectedElement === "trackInfo"
              ? "Track details"
              : selectedElement[0].toUpperCase() + selectedElement.slice(1)}
          </h3>
        </div>
        <span className="composition-aspect-chip">{aspect}</span>
      </div>
      <div className="composition-bounds-grid">
        <NumberControl
          label="X"
          value={bounds.x}
          disabled={disabled}
          onCommit={(value) => changeBounds("x", value)}
        />
        <NumberControl
          label="Y"
          value={bounds.y}
          disabled={disabled}
          onCommit={(value) => changeBounds("y", value)}
        />
        <NumberControl
          label="Width"
          value={bounds.width}
          disabled={disabled}
          onCommit={(value) => changeBounds("width", value)}
        />
        <NumberControl
          label="Height"
          value={bounds.height}
          disabled={disabled}
          onCommit={(value) => changeBounds("height", value)}
        />
      </div>

      {selectedElement === "background" ? (
        <div className="composition-style-controls">
          <label>
            Image fit
            <select
              value={composition?.background.fit ?? "cover"}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  background: {
                    ...composition?.background,
                    fit: event.currentTarget.value as "cover" | "contain",
                  },
                })
              }
            >
              <option value="cover">Fill frame</option>
              <option value="contain">Fit image</option>
            </select>
          </label>
          <NumberControl
            label="Focus X"
            value={(composition?.background.focusX ?? 50) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) =>
              patchComposition({ background: { ...composition?.background, focusX: value * 100 } })
            }
          />
          <NumberControl
            label="Focus Y"
            value={(composition?.background.focusY ?? 50) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) =>
              patchComposition({ background: { ...composition?.background, focusY: value * 100 } })
            }
          />
          <NumberControl
            label="Readability scrim"
            value={(composition?.background.scrimOpacity ?? 0) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) =>
              patchComposition({
                background: { ...composition?.background, scrimOpacity: value * 100 },
              })
            }
          />
        </div>
      ) : null}

      {selectedElement === "artwork" ? (
        <div className="composition-style-controls">
          <label>
            Image fit
            <select
              value={composition?.artwork.fit ?? "cover"}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  artwork: {
                    ...composition?.artwork,
                    fit: event.currentTarget.value as "cover" | "contain",
                  },
                })
              }
            >
              <option value="cover">Fill frame</option>
              <option value="contain">Fit image</option>
            </select>
          </label>
          <label>
            Frame
            <select
              value={composition?.artwork.frame ?? "square"}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  artwork: {
                    ...composition?.artwork,
                    frame: event.currentTarget.value as "square" | "circle" | "rounded",
                  },
                })
              }
            >
              <option value="square">Square</option>
              <option value="rounded">Rounded</option>
              <option value="circle">Circle</option>
            </select>
          </label>
          <NumberControl
            label="Opacity"
            value={(composition?.artwork.opacity ?? 100) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) =>
              patchComposition({ artwork: { ...composition?.artwork, opacity: value * 100 } })
            }
          />
        </div>
      ) : null}

      {selectedElement === "captions" ? (
        <div className="composition-style-controls">
          <label>
            Font
            <select
              value={composition?.captions.font ?? "sans"}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  captions: {
                    ...composition?.captions,
                    font: event.currentTarget.value as "sans" | "serif" | "mono",
                  },
                })
              }
            >
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Mono</option>
            </select>
          </label>
          <ColorControl
            label="Text color"
            value={composition?.captions.color ?? "#ffffff"}
            disabled={disabled}
            onChange={(color) =>
              patchComposition({ captions: { ...composition?.captions, color } })
            }
          />
          <NumberControl
            label="Text size"
            value={composition?.captions.size ?? 1}
            suffix="×"
            min={0.5}
            max={2}
            step={0.05}
            disabled={disabled}
            onCommit={(size) => patchComposition({ captions: { ...composition?.captions, size } })}
          />
          <NumberControl
            label="Box opacity"
            value={(composition?.captions.backgroundOpacity ?? 76) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) =>
              patchComposition({
                captions: { ...composition?.captions, backgroundOpacity: value * 100 },
              })
            }
          />
        </div>
      ) : null}

      {selectedElement === "promo" ? (
        <div className="composition-style-controls">
          <label className="composition-promo-text">
            Promotional text
            <input
              value={composition?.promo.text ?? ""}
              maxLength={120}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  promo: { ...composition?.promo, text: event.currentTarget.value },
                })
              }
            />
          </label>
          <label className="composition-check-control">
            <input
              type="checkbox"
              checked={composition?.promo.visible ?? false}
              disabled={disabled}
              onChange={(event) =>
                patchComposition({
                  promo: { ...composition?.promo, visible: event.currentTarget.checked },
                })
              }
            />
            Show promotional text
          </label>
          <ColorControl
            label="Text color"
            value={composition?.promo.color ?? "#ffffff"}
            disabled={disabled}
            onChange={(color) => patchComposition({ promo: { ...composition?.promo, color } })}
          />
          <NumberControl
            label="Text size"
            value={composition?.promo.size ?? 1}
            suffix="×"
            min={0.5}
            max={2}
            step={0.05}
            disabled={disabled}
            onCommit={(size) => patchComposition({ promo: { ...composition?.promo, size } })}
          />
        </div>
      ) : null}

      {selectedElement === "logo" ? (
        <div className="composition-style-controls">
          <NumberControl
            label="Opacity"
            value={(settings.logoOpacity ?? 100) / 100}
            suffix="%"
            disabled={disabled}
            onCommit={(value) => onChange({ ...settings, logoOpacity: value * 100 })}
          />
          <p className="composition-control-hint">
            Dragging the logo uses a manual placement for this visual mode.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ColorControl({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="composition-color-control">
      {label}
      <input
        type="color"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}
