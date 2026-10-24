"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  ImagePlus,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Unlock,
} from "lucide-react";
import {
  MAX_COMPOSITION_ELEMENTS,
  MAX_CIRCLE_INSTANCES,
  duplicateVisualizer,
  isCircularMode,
  newElement,
  type CreativeElement,
  type FrameTransform,
  type LyricStyle,
  type VisualizerInstance,
} from "@/lib/composition/model";
import { boundedTransform } from "@/lib/composition/geometry";
import type { CompositionPanelProps, EditableElement, ElementKind } from "./type";

function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`composition-field ${className}`}>
      <span className="composition-field-label">{label}</span>
      {children}
      {hint ? <small className="composition-field-hint">{hint}</small> : null}
    </div>
  );
}

function NumericField({
  label,
  value,
  min,
  max,
  step = 0.1,
  disabled,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange(value: number): void;
  suffix?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const formatted = Number(value.toFixed(2)).toString();
  return (
    <Field label={label} className="composition-numeric-field">
      <div className="composition-number-wrap">
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={focused ? draft : formatted}
          onFocus={() => {
            setDraft(formatted);
            setFocused(true);
          }}
          onChange={(event) => {
            const nextText = event.currentTarget.value;
            setDraft(nextText);
            if (nextText.trim() === "") return;
            const next = Number(nextText);
            if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
          }}
          onBlur={(event) => {
            const text = event.currentTarget.value.trim();
            const next = Number(text);
            if (text !== "" && Number.isFinite(next)) {
              onChange(Math.min(max, Math.max(min, next)));
            }
            setFocused(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {suffix ? <span className="composition-number-suffix">{suffix}</span> : null}
      </div>
    </Field>
  );
}

function ColorField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <Field label={label} className="composition-color-field">
      <input
        type="color"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function TextField({
  label,
  value,
  disabled,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
  multiline?: boolean;
}) {
  return (
    <Field label={label}>
      {multiline ? (
        <textarea
          aria-label={label}
          value={value}
          rows={3}
          maxLength={600}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <input
          aria-label={label}
          type="text"
          value={value}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value.slice(0, 80))}
        />
      )}
    </Field>
  );
}

function LayerNameInput({
  name,
  disabled,
  onFocus,
  onRename,
}: {
  name: string;
  disabled?: boolean;
  onFocus(): void;
  onRename(name: string): void;
}) {
  const [draft, setDraft] = useState(name);
  const discardDraft = useRef(false);

  return (
    <input
      className="composition-layer-name"
      type="text"
      aria-label={`Rename ${name}`}
      value={draft}
      maxLength={80}
      disabled={disabled}
      onFocus={() => {
        onFocus();
      }}
      onChange={(event) => setDraft(event.currentTarget.value.slice(0, 80))}
      onBlur={() => {
        if (discardDraft.current) {
          discardDraft.current = false;
          setDraft(name);
          return;
        }
        const next = draft.trim().slice(0, 80);
        if (next) onRename(next);
        else setDraft(name);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          discardDraft.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function moveItem<T>(items: readonly T[], index: number, offset: -1 | 1): T[] {
  const nextIndex = index + offset;
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return [...items];
  const next = [...items];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

function CompositionPanelView({
  composition,
  settings,
  selectedId,
  onSelect,
  onEditSubtitles,
  onChange,
  onAddImage,
  onTemplate,
  variant,
  disabled = false,
  assetsDisabled = false,
}: CompositionPanelProps) {
  const [activeTab, setActiveTab] = useState<"add" | "layers">("layers");
  const imageInput = useRef<HTMLInputElement>(null);
  const hasCapacity =
    composition.visualizers.length + composition.elements.length + 1 < MAX_COMPOSITION_ELEMENTS;
  const selectedVisualizer = composition.visualizers.find((item) => item.id === selectedId);
  const selectedElement = composition.elements.find((item) => item.id === selectedId);
  const selectedLyrics = selectedId === "lyrics";
  const selectedTransform = selectedVisualizer?.transform ?? selectedElement?.transform;
  const selectedLocked = Boolean(selectedVisualizer?.locked || selectedElement?.locked);
  const inspectorDisabled = disabled || (selectedLocked && !selectedLyrics);

  const changeVisualizer = useCallback(
    (id: string, patch: Partial<VisualizerInstance>, group?: string) => {
      if (disabled) return;
      onChange(
        {
          ...composition,
          visualizers: composition.visualizers.map((item) =>
            item.id === id ? { ...item, ...patch } : item,
          ),
        },
        group,
      );
    },
    [composition, disabled, onChange],
  );

  const changeElement = useCallback(
    (id: string, patch: Partial<CreativeElement>, group?: string) => {
      if (disabled) return;
      onChange(
        {
          ...composition,
          elements: composition.elements.map((item) =>
            item.id === id ? ({ ...item, ...patch } as CreativeElement) : item,
          ),
        },
        group,
      );
    },
    [composition, disabled, onChange],
  );

  const changeLyrics = useCallback(
    (patch: Partial<LyricStyle>, group?: string) => {
      if (disabled) return;
      onChange({ ...composition, lyrics: { ...composition.lyrics, ...patch } }, group);
    },
    [composition, disabled, onChange],
  );

  const addElement = useCallback(
    (type: ElementKind) => {
      if (disabled || !hasCapacity) return;
      const element = newElement(type);
      onChange({ ...composition, elements: [...composition.elements, element] });
      onSelect(element.id);
      setActiveTab("layers");
    },
    [composition, disabled, hasCapacity, onChange, onSelect],
  );

  const handleImageFile = useCallback(
    (file?: File) => {
      if (!file || disabled || assetsDisabled || !hasCapacity) return;
      onAddImage(file);
      setActiveTab("layers");
    },
    [disabled, assetsDisabled, hasCapacity, onAddImage],
  );

  const duplicateSelected = useCallback(() => {
    if (disabled || !selectedId || !hasCapacity) return;
    if (selectedVisualizer) {
      if (!isCircularMode(settings.mode) || composition.visualizers.length >= MAX_CIRCLE_INSTANCES)
        return;
      const next = duplicateVisualizer(composition, selectedVisualizer.id);
      if (next === composition) return;
      const duplicate = next.visualizers.at(-1);
      onChange(next);
      if (duplicate) onSelect(duplicate.id);
      return;
    }
    if (!selectedElement) return;
    const duplicate = {
      ...selectedElement,
      id: crypto.randomUUID(),
      name: `${selectedElement.name} copy`.slice(0, 80),
      locked: false,
      transform: boundedTransform({
        ...selectedElement.transform,
        x: selectedElement.transform.x + 0.04,
        y: selectedElement.transform.y + 0.04,
      }),
    } as CreativeElement;
    onChange({ ...composition, elements: [...composition.elements, duplicate] });
    onSelect(duplicate.id);
  }, [
    composition,
    disabled,
    hasCapacity,
    onChange,
    onSelect,
    selectedElement,
    selectedId,
    selectedVisualizer,
    settings.mode,
  ]);

  const deleteSelected = useCallback(() => {
    if (disabled || !selectedId) return;
    if (selectedVisualizer && composition.visualizers.length > 1) {
      const visualizers = composition.visualizers.filter(
        (item) => item.id !== selectedVisualizer.id,
      );
      const logoFrameId =
        composition.logoFrameId === selectedVisualizer.id
          ? (visualizers[0]?.id ?? null)
          : composition.logoFrameId;
      onChange({ ...composition, visualizers, logoFrameId });
      onSelect(visualizers[0]?.id ?? null);
    } else if (selectedElement) {
      onChange({
        ...composition,
        elements: composition.elements.filter((item) => item.id !== selectedElement.id),
      });
      onSelect(composition.visualizers[0]?.id ?? null);
    }
  }, [composition, disabled, onChange, onSelect, selectedElement, selectedId, selectedVisualizer]);

  const moveVisualizer = useCallback(
    (index: number, offset: -1 | 1) => {
      if (disabled) return;
      onChange({ ...composition, visualizers: moveItem(composition.visualizers, index, offset) });
    },
    [composition, disabled, onChange],
  );

  const moveElement = useCallback(
    (index: number, offset: -1 | 1) => {
      if (disabled) return;
      onChange({ ...composition, elements: moveItem(composition.elements, index, offset) });
    },
    [composition, disabled, onChange],
  );

  const updateTransform = useCallback(
    (key: keyof FrameTransform, displayedValue: number) => {
      if (inspectorDisabled || !selectedId || !selectedTransform) return;
      const value = key === "rotation" ? displayedValue : displayedValue / 100;
      const transform = boundedTransform({ ...selectedTransform, [key]: value });
      if (selectedVisualizer) {
        changeVisualizer(selectedVisualizer.id, { transform }, `transform-${selectedId}`);
      } else if (selectedElement) {
        changeElement(selectedElement.id, { transform }, `transform-${selectedId}`);
      }
    },
    [
      changeElement,
      changeVisualizer,
      inspectorDisabled,
      selectedElement,
      selectedId,
      selectedTransform,
      selectedVisualizer,
    ],
  );

  const setLogoFrame = useCallback(
    (id: string) => {
      if (disabled) return;
      onChange({ ...composition, logoFrameId: id });
    },
    [composition, disabled, onChange],
  );

  const capacityLabel = useMemo(
    () =>
      `${composition.visualizers.length + composition.elements.length + 1}/${MAX_COMPOSITION_ELEMENTS} items`,
    [composition.elements.length, composition.visualizers.length],
  );

  const renderLayerRow = (
    item: VisualizerInstance | EditableElement,
    index: number,
    group: "visualizers" | "elements",
  ) => {
    const isVisualizer = group === "visualizers";
    const visualIndex = isVisualizer
      ? composition.visualizers.findIndex((candidate) => candidate.id === item.id)
      : -1;
    const itemIndex = isVisualizer ? visualIndex : index;
    const itemCount = isVisualizer ? composition.visualizers.length : composition.elements.length;
    const selected = selectedId === item.id;
    const element = "type" in item ? item : null;
    const imageType = !isVisualizer && element?.type === "image";
    const typeName = !element
      ? "Visualizer"
      : element.type === "shape"
        ? element.shape
        : element.type;
    const locked = item.locked;

    return (
      <li className={`composition-layer ${selected ? "is-selected" : ""}`} key={item.id}>
        <button
          type="button"
          className="composition-layer-select"
          aria-pressed={selected}
          onClick={() => onSelect(item.id)}
        >
          <span className="composition-layer-kind">{typeName}</span>
          <span className="composition-layer-state">
            {!item.visible ? "Hidden" : locked ? "Locked" : ""}
            {isVisualizer && composition.logoFrameId === item.id ? " · Logo frame" : ""}
          </span>
        </button>
        <LayerNameInput
          key={`${item.id}:${item.name}`}
          name={item.name}
          disabled={disabled}
          onFocus={() => onSelect(item.id)}
          onRename={(name) =>
            isVisualizer ? changeVisualizer(item.id, { name }) : changeElement(item.id, { name })
          }
        />
        <div className="composition-layer-actions">
          <button
            type="button"
            className="composition-icon-button"
            aria-label={`${item.visible ? "Hide" : "Show"} ${item.name}`}
            title={`${item.visible ? "Hide" : "Show"} layer`}
            disabled={disabled}
            onClick={() =>
              isVisualizer
                ? changeVisualizer(item.id, { visible: !item.visible }, `visibility-${item.id}`)
                : changeElement(item.id, { visible: !item.visible }, `visibility-${item.id}`)
            }
          >
            {item.visible ? (
              <Eye size={15} aria-hidden="true" />
            ) : (
              <EyeOff size={15} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="composition-icon-button"
            aria-label={`${locked ? "Unlock" : "Lock"} ${item.name}`}
            title={`${locked ? "Unlock" : "Lock"} layer`}
            aria-pressed={locked}
            disabled={disabled}
            onClick={() =>
              isVisualizer
                ? changeVisualizer(item.id, { locked: !locked }, `lock-${item.id}`)
                : changeElement(item.id, { locked: !locked }, `lock-${item.id}`)
            }
          >
            {locked ? (
              <Lock size={15} aria-hidden="true" />
            ) : (
              <Unlock size={15} aria-hidden="true" />
            )}
          </button>
          {isVisualizer ? (
            <button
              type="button"
              className={`composition-logo-button ${composition.logoFrameId === item.id ? "is-active" : ""}`}
              aria-label={`Use ${item.name} as the logo frame`}
              aria-pressed={composition.logoFrameId === item.id}
              title="Attach logo to this visualizer frame"
              disabled={disabled}
              onClick={() => setLogoFrame(item.id)}
            >
              Logo
            </button>
          ) : null}
          <button
            type="button"
            className="composition-icon-button"
            aria-label={`Move ${item.name} up`}
            title="Move up"
            disabled={disabled || itemIndex <= 0}
            onClick={() =>
              isVisualizer ? moveVisualizer(itemIndex, -1) : moveElement(itemIndex, -1)
            }
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="composition-icon-button"
            aria-label={`Move ${item.name} down`}
            title="Move down"
            disabled={disabled || itemIndex >= itemCount - 1}
            onClick={() =>
              isVisualizer ? moveVisualizer(itemIndex, 1) : moveElement(itemIndex, 1)
            }
          >
            <ArrowDown size={15} aria-hidden="true" />
          </button>
          {imageType ? (
            <span className="composition-image-marker" aria-label="Image layer">
              IMG
            </span>
          ) : null}
        </div>
      </li>
    );
  };

  const renderLayers = () => (
    <div className="composition-layers-view">
      <div className="composition-list-heading">
        <h3>Visualizers</h3>
        <span>{composition.visualizers.length}</span>
      </div>
      {!isCircularMode(settings.mode) && composition.visualizers.length > 1 ? (
        <p className="composition-note">
          Only the first visualizer is shown in this style. Extra frames stay in the composition.
        </p>
      ) : null}
      <ul className="composition-layer-list">
        {composition.visualizers.map((item, index) => renderLayerRow(item, index, "visualizers"))}
      </ul>

      <div className="composition-list-heading composition-elements-heading">
        <h3>Elements</h3>
        <span>{composition.elements.length}</span>
      </div>
      <ul className="composition-layer-list">
        {composition.elements.map((item, index) => renderLayerRow(item, index, "elements"))}
      </ul>
      <div className="composition-layer-list composition-lyrics-layer">
        <button
          type="button"
          className="composition-layer-select composition-lyrics-select"
          aria-pressed={selectedLyrics}
          onClick={() => onSelect("lyrics")}
        >
          <span className="composition-layer-kind">Lyrics</span>
          <span className="composition-layer-state">Subtitle style</span>
        </button>
      </div>
      <p className="composition-count-note">{capacityLabel}; lyrics are included in the limit.</p>
    </div>
  );

  const renderAdd = () => (
    <div className="composition-add-view">
      <div className="composition-list-heading">
        <h3>Add element</h3>
        <span>{capacityLabel}</span>
      </div>
      <div className="composition-add-grid">
        <button
          type="button"
          disabled={disabled || !hasCapacity}
          onClick={() => addElement("text")}
        >
          <Plus size={15} aria-hidden="true" /> Text
        </button>
        <button
          type="button"
          disabled={disabled || !hasCapacity}
          onClick={() => addElement("rectangle")}
        >
          <Plus size={15} aria-hidden="true" /> Rectangle
        </button>
        <button
          type="button"
          disabled={disabled || !hasCapacity}
          onClick={() => addElement("ellipse")}
        >
          <Plus size={15} aria-hidden="true" /> Ellipse
        </button>
        <button
          type="button"
          disabled={disabled || assetsDisabled || !hasCapacity}
          onClick={() => imageInput.current?.click()}
          title={assetsDisabled ? "Add images after subtitle generation finishes." : undefined}
        >
          <ImagePlus size={15} aria-hidden="true" /> Image
        </button>
        <input
          ref={imageInput}
          className="composition-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          aria-label="Choose image to add"
          tabIndex={-1}
          disabled={disabled || assetsDisabled || !hasCapacity}
          onChange={(event) => {
            handleImageFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  );

  const renderTransform = () => {
    if (!selectedTransform) return null;
    return (
      <section
        className="composition-inspector-section"
        aria-labelledby="composition-transform-title"
      >
        <h3 id="composition-transform-title">Transform</h3>
        <div className="composition-control-grid">
          <NumericField
            label="Horizontal position (%)"
            value={selectedTransform.x * 100}
            min={0}
            max={100}
            disabled={inspectorDisabled}
            onChange={(value) => updateTransform("x", value)}
            suffix="%"
          />
          <NumericField
            label="Vertical position (%)"
            value={selectedTransform.y * 100}
            min={0}
            max={100}
            disabled={inspectorDisabled}
            onChange={(value) => updateTransform("y", value)}
            suffix="%"
          />
          <NumericField
            label="Width (%)"
            value={selectedTransform.width * 100}
            min={3}
            max={150}
            disabled={inspectorDisabled}
            onChange={(value) => updateTransform("width", value)}
            suffix="%"
          />
          <NumericField
            label="Height (%)"
            value={selectedTransform.height * 100}
            min={3}
            max={150}
            disabled={inspectorDisabled}
            onChange={(value) => updateTransform("height", value)}
            suffix="%"
          />
          <NumericField
            label="Rotation"
            value={selectedTransform.rotation}
            min={-180}
            max={180}
            step={1}
            disabled={inspectorDisabled}
            onChange={(value) => updateTransform("rotation", value)}
            suffix="°"
          />
        </div>
      </section>
    );
  };

  const renderLyricsInspector = () => (
    <>
      <section className="composition-inspector-section" aria-labelledby="composition-lyrics-title">
        <h3 id="composition-lyrics-title">Lyrics</h3>
        {onEditSubtitles && (
          <button className="button button-soft" onClick={onEditSubtitles}>
            Edit subtitle blocks
          </button>
        )}
        <Field label="Line animation">
          <select
            aria-label="Line animation"
            value={composition.lyrics.animation}
            disabled={disabled}
            onChange={(event) =>
              changeLyrics({ animation: event.currentTarget.value as LyricStyle["animation"] })
            }
          >
            <option value="static">Static</option>
            <option value="fade">Fade</option>
            <option value="pop">Pop</option>
            <option value="highlight">Highlight</option>
            <option value="karaoke">Karaoke</option>
          </select>
        </Field>
        <p className="composition-note">
          Word timing needs Gemini or timed subtitle import. Lyrics render on-device; animation is
          line-only without word timing.
        </p>
        <div className="composition-control-grid">
          <ColorField
            label="Lyric color"
            value={composition.lyrics.color}
            disabled={disabled}
            onChange={(color) => changeLyrics({ color }, "lyrics-color")}
          />
          <ColorField
            label="Highlight color"
            value={composition.lyrics.highlightColor}
            disabled={disabled}
            onChange={(highlightColor) =>
              changeLyrics({ highlightColor }, "lyrics-highlight-color")
            }
          />
          <NumericField
            label="Font size (%)"
            value={composition.lyrics.fontSize * 100}
            min={2}
            max={12}
            disabled={disabled}
            onChange={(value) => changeLyrics({ fontSize: value / 100 }, "lyrics-size")}
            suffix="%"
          />
          <NumericField
            label="Vertical position (%)"
            value={composition.lyrics.position * 100}
            min={15}
            max={95}
            disabled={disabled}
            onChange={(value) => changeLyrics({ position: value / 100 }, "lyrics-position")}
            suffix="%"
          />
        </div>
        <label className="composition-check-field">
          <input
            type="checkbox"
            aria-label="Show lyric background"
            checked={composition.lyrics.background}
            disabled={disabled}
            onChange={(event) => changeLyrics({ background: event.currentTarget.checked })}
          />
          <span>Show lyric background</span>
        </label>
      </section>
    </>
  );

  const renderVisualizerInspector = (item: VisualizerInstance) => (
    <>
      {renderTransform()}
      <section
        className="composition-inspector-section"
        aria-labelledby="composition-instance-color-title"
      >
        <div className="composition-section-heading">
          <h3 id="composition-instance-color-title">Instance colors</h3>
          <button
            type="button"
            className="composition-reset-button"
            disabled={disabled || !item.palette}
            onClick={() => {
              changeVisualizer(item.id, { palette: undefined }, `palette-reset-${item.id}`);
            }}
          >
            <RotateCcw size={13} aria-hidden="true" /> Reset
          </button>
        </div>
        <div className="composition-control-grid">
          <ColorField
            label="Primary color"
            value={item.palette?.primary ?? settings.primary}
            disabled={inspectorDisabled}
            onChange={(primary) =>
              changeVisualizer(
                item.id,
                { palette: { primary, secondary: item.palette?.secondary ?? settings.secondary } },
                `palette-${item.id}`,
              )
            }
          />
          <ColorField
            label="Accent color"
            value={item.palette?.secondary ?? settings.secondary}
            disabled={inspectorDisabled}
            onChange={(secondary) =>
              changeVisualizer(
                item.id,
                { palette: { primary: item.palette?.primary ?? settings.primary, secondary } },
                `palette-${item.id}`,
              )
            }
          />
        </div>
        <p className="composition-note">
          Other visual style controls remain shared in the Style panel.
        </p>
      </section>
    </>
  );

  const renderElementInspector = (item: CreativeElement) => (
    <>
      <section
        className="composition-inspector-section"
        aria-labelledby="composition-element-style-title"
      >
        <h3 id="composition-element-style-title">Element style</h3>
        {item.type === "text" ? (
          <>
            {item.binding === "none" ? (
              <TextField
                label="Text"
                value={item.text}
                multiline
                disabled={inspectorDisabled}
                onChange={(text) => changeElement(item.id, { text }, `text-${item.id}`)}
              />
            ) : null}
            <Field label="Text source">
              <select
                aria-label="Text source"
                value={item.binding}
                disabled={inspectorDisabled}
                onChange={(event) =>
                  changeElement(item.id, {
                    binding: event.currentTarget.value as typeof item.binding,
                  })
                }
              >
                <option value="none">Custom text</option>
                <option value="title">Track title</option>
                <option value="artist">Track artist</option>
                <option value="timer">Playback timer</option>
              </select>
            </Field>
            <div className="composition-control-grid">
              <Field label="Font">
                <select
                  aria-label="Font"
                  value={item.font}
                  disabled={inspectorDisabled}
                  onChange={(event) =>
                    changeElement(item.id, { font: event.currentTarget.value as typeof item.font })
                  }
                >
                  <option value="sans">Sans</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Mono</option>
                </select>
              </Field>
              <NumericField
                label="Font size (%)"
                value={item.fontSize * 100}
                min={1}
                max={30}
                disabled={inspectorDisabled}
                onChange={(value) =>
                  changeElement(item.id, { fontSize: value / 100 }, `font-size-${item.id}`)
                }
                suffix="%"
              />
              <Field label="Alignment">
                <select
                  aria-label="Text alignment"
                  value={item.align}
                  disabled={inspectorDisabled}
                  onChange={(event) =>
                    changeElement(item.id, {
                      align: event.currentTarget.value as typeof item.align,
                    })
                  }
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </Field>
              <ColorField
                label="Text color"
                value={item.color}
                disabled={inspectorDisabled}
                onChange={(color) => changeElement(item.id, { color }, `text-color-${item.id}`)}
              />
            </div>
          </>
        ) : null}
        {item.type === "shape" ? (
          <div className="composition-control-grid">
            <ColorField
              label="Fill color"
              value={item.color}
              disabled={inspectorDisabled}
              onChange={(color) => changeElement(item.id, { color }, `shape-color-${item.id}`)}
            />
            {item.shape === "rectangle" ? (
              <NumericField
                label="Corner roundness (%)"
                value={item.roundness * 100}
                min={0}
                max={100}
                disabled={inspectorDisabled}
                onChange={(value) =>
                  changeElement(item.id, { roundness: value / 100 }, `roundness-${item.id}`)
                }
                suffix="%"
              />
            ) : null}
          </div>
        ) : null}
        {item.type === "image" ? (
          <Field label="Image fit">
            <select
              aria-label="Image fit"
              value={item.fit}
              disabled={inspectorDisabled}
              onChange={(event) =>
                changeElement(item.id, { fit: event.currentTarget.value as typeof item.fit })
              }
            >
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
            </select>
          </Field>
        ) : null}
        <NumericField
          label="Opacity (%)"
          value={item.opacity * 100}
          min={0}
          max={100}
          disabled={inspectorDisabled}
          onChange={(value) =>
            changeElement(item.id, { opacity: value / 100 }, `opacity-${item.id}`)
          }
          suffix="%"
        />
      </section>
      {renderTransform()}
    </>
  );

  const renderInspector = () => {
    if (selectedLyrics) return renderLyricsInspector();
    if (selectedVisualizer) return renderVisualizerInspector(selectedVisualizer);
    if (selectedElement) return renderElementInspector(selectedElement);
    return (
      <p className="composition-empty-state">
        Select a visualizer, element, or lyrics layer to edit its properties.
      </p>
    );
  };

  return (
    <section
      className={`composition-panel composition-panel-${variant}`}
      aria-label={
        variant === "layers" ? "Composition layers and add controls" : "Composition inspector"
      }
    >
      <header className="composition-panel-header">
        <div>
          <p className="composition-panel-kicker">Composition</p>
          <h2>{variant === "layers" ? "Layers" : selectedLyrics ? "Lyrics style" : "Inspector"}</h2>
        </div>
        {variant === "layers" && selectedId && (selectedElement || selectedVisualizer) ? (
          <div className="composition-header-actions">
            <button
              type="button"
              className="composition-icon-button"
              aria-label="Duplicate selected layer"
              title="Duplicate"
              disabled={
                disabled ||
                !hasCapacity ||
                (Boolean(selectedVisualizer) &&
                  (!isCircularMode(settings.mode) ||
                    composition.visualizers.length >= MAX_CIRCLE_INSTANCES))
              }
              onClick={duplicateSelected}
            >
              <Copy size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="composition-icon-button composition-delete-icon"
              aria-label="Delete selected layer"
              title="Delete"
              disabled={
                disabled || (Boolean(selectedVisualizer) && composition.visualizers.length <= 1)
              }
              onClick={deleteSelected}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>
      {variant === "layers" ? (
        <>
          <div className="composition-tabs" role="group" aria-label="Composition controls">
            <button
              type="button"
              aria-pressed={activeTab === "add"}
              onClick={() => setActiveTab("add")}
            >
              Add
            </button>
            <button
              type="button"
              aria-pressed={activeTab === "layers"}
              onClick={() => setActiveTab("layers")}
            >
              Layers
            </button>
          </div>
          <div className="composition-panel-content">
            {activeTab === "add" ? renderAdd() : renderLayers()}
          </div>
          <details className="composition-templates">
            <summary>Creator templates</summary>
            <div className="composition-template-grid">
              {(
                [
                  ["cover", "Cover"],
                  ["portrait", "Portrait"],
                  ["square", "Square"],
                  ["dual", "Dual visualizer"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" disabled={disabled} onClick={() => onTemplate(id)}>
                  {label}
                </button>
              ))}
            </div>
          </details>
        </>
      ) : (
        <div className="composition-panel-content composition-inspector-content">
          {renderInspector()}
        </div>
      )}
    </section>
  );
}

export const CompositionPanel = memo(CompositionPanelView);
