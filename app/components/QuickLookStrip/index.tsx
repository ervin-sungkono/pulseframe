import { useState } from "react";
import type { CSSProperties } from "react";
import { Bookmark, Check, Plus, PinOff, RotateCcw, Undo2, Redo2 } from "lucide-react";
import { BUILTIN_LOOKS } from "@/lib/visual/customizer-config";
import { visualModeName, type PresetStyle, type SavedPreset } from "@/lib/visual/presets";
import type { QuickLookStripProps } from "./type";

export type { ActiveLook } from "./type";

function LookArt({ settings }: { settings: PresetStyle }) {
  const style = {
    "--look-primary": settings.primary,
    "--look-secondary": settings.secondary,
    "--look-background": settings.background,
  } as CSSProperties;
  return (
    <span className={`look-art ${settings.mode}`} style={style} aria-hidden="true">
      <i />
    </span>
  );
}

export function QuickLookStrip({
  settings,
  library,
  active,
  modified,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onApplyBuiltin,
  onApplyPreset,
  onSave,
  onUpdate,
  onManage,
  onPresetChanged,
}: QuickLookStripProps) {
  const [view, setView] = useState<"builtin" | "personal">("builtin");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = active?.preset
    ? (library.pinnedPresets.find((item) => item.id === active.id) ??
      library.presets.find((item) => item.id === active.id) ??
      active.preset)
    : null;
  const unpin = async (preset: SavedPreset) => {
    setBusy(preset.id);
    setError(null);
    try {
      const updated = await library.update(preset.id, {
        pinned: false,
        expectedRevision: preset.revision,
      });
      onPresetChanged(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this shortcut.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="control-section looks-section" aria-label="Quick Looks">
      <div className="quick-look-heading">
        <div className="control-title">
          <span>01</span>
          <h3>Quick Looks</h3>
        </div>
        <button className="quick-look-save" onClick={onSave} disabled={disabled}>
          <Plus size={15} /> Save Quick Look
        </button>
      </div>
      <div className="quick-look-tabs" role="group" aria-label="Quick Look collection">
        <button
          aria-pressed={view === "builtin"}
          className={view === "builtin" ? "active" : ""}
          onClick={() => setView("builtin")}
        >
          Built-in
        </button>
        <button
          aria-pressed={view === "personal"}
          className={view === "personal" ? "active" : ""}
          onClick={() => setView("personal")}
        >
          My Quick Looks
        </button>
        <button className="quick-look-manage" disabled={disabled} onClick={onManage}>
          <Bookmark size={14} /> Manage
        </button>
      </div>
      {view === "builtin" ? (
        <div className="look-strip" role="group" aria-label="Built-in Quick Looks">
          {BUILTIN_LOOKS.map((look) => {
            const selected = active?.id === look.id && !modified;
            return (
              <button
                key={look.id}
                className={`look-card ${selected ? "selected" : ""}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onApplyBuiltin(look)}
              >
                <LookArt settings={look.settings} />
                <strong>{look.name}</strong>
                <small>{look.caption}</small>
                {selected && <Check className="look-check" size={14} />}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div
            className="look-strip"
            role="group"
            aria-label="My Quick Looks"
            aria-busy={library.loading}
          >
            {library.pinnedPresets.map((preset) => {
              const selected = active?.id === preset.id && !modified;
              return (
                <div className="personal-look" key={preset.id}>
                  <button
                    className={`look-card ${selected ? "selected" : ""}`}
                    aria-pressed={selected}
                    disabled={disabled || busy !== null}
                    onClick={() => onApplyPreset(preset)}
                  >
                    <LookArt settings={preset.settings} />
                    <strong>{preset.name}</strong>
                    <small>
                      {visualModeName(preset.settings.mode)} ·{" "}
                      {preset.settings.particles ? "Particles" : "Clean"}
                    </small>
                    {selected && <Check className="look-check" size={14} />}
                  </button>
                  <button
                    className="look-unpin"
                    aria-label={`Remove ${preset.name} from Quick Looks`}
                    title="Remove shortcut; keep saved preset"
                    disabled={disabled || busy !== null}
                    onClick={() => {
                      void unpin(preset);
                    }}
                  >
                    <PinOff size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          {!library.pinnedPresets.length && !library.loading && (
            <div className="quick-look-empty">
              <strong>Keep a favorite close</strong>
              <p>Save your current settings, or pin an existing preset from the library.</p>
            </div>
          )}
          {library.loading && (
            <p className="preset-status" role="status">
              Loading Quick Looks…
            </p>
          )}
          {library.error && (
            <div className="preset-error" role="alert">
              <span>{library.error}</span>
              <button
                disabled={disabled || library.loading}
                onClick={() => {
                  void library.refresh();
                }}
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="preset-error" role="alert">
          {error}
        </p>
      )}
      <div className="quick-look-current" aria-live="polite">
        <span>
          {active ? active.name : `Custom ${visualModeName(settings.mode)}`}
          {active && modified && <em>Modified</em>}
        </span>
        {saved && modified && (
          <button disabled={disabled} onClick={() => onUpdate(saved)}>
            Update
          </button>
        )}
        {active && modified && (
          <button disabled={disabled} onClick={onSave}>
            Save a copy
          </button>
        )}
      </div>
      <div className="settings-history">
        <button aria-label="Undo customization" disabled={disabled || !canUndo} onClick={onUndo}>
          <Undo2 size={15} /> Undo
        </button>
        <button aria-label="Redo customization" disabled={disabled || !canRedo} onClick={onRedo}>
          <Redo2 size={15} /> Redo
        </button>
        {active && modified && (
          <button
            disabled={disabled}
            onClick={() => {
              if (active.preset) onApplyPreset(saved ?? active.preset);
              else {
                const look = BUILTIN_LOOKS.find((item) => item.id === active.id);
                if (look) onApplyBuiltin(look);
              }
            }}
          >
            <RotateCcw size={14} /> Reapply
          </button>
        )}
      </div>
    </section>
  );
}
