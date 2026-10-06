"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { presetStyle, visualModeName, type SavedPreset } from "@/lib/presets";
import type { VisualSettings } from "@/lib/visualizer";
import { PresetRequestError, type PresetLibrary } from "@/hooks/use-presets";

type SaveDraft = {
  id: string;
  settings: ReturnType<typeof presetStyle>;
  target: SavedPreset | null;
};

type Props = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  settings: VisualSettings;
  library: PresetLibrary;
  hasMedia: boolean;
  pinned?: boolean;
  target?: SavedPreset | null;
  onSaved?: (preset: SavedPreset) => void;
};

export function PresetSaveDialog({ open, onOpenChange, settings, library, hasMedia, pinned, target = null, onSaved }: Props) {
  const [draft, setDraft] = useState<SaveDraft | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"update" | "copy" | null>(null);
  const [formError, setFormError] = useState("");
  const settingsRef = useRef(settings);
  const targetRef = useRef(target);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
    targetRef.current = target;
  }, [settings, target]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const timer = window.setTimeout(() => {
        const snapshotTarget = targetRef.current ? { ...targetRef.current, settings: presetStyle(targetRef.current.settings) } : null;
        setDraft({ id: crypto.randomUUID(), settings: presetStyle(settingsRef.current), target: snapshotTarget });
        setName(snapshotTarget?.name ?? "");
        setFormError("");
        wasOpenRef.current = true;
      }, 0);
      return () => { window.clearTimeout(timer); wasOpenRef.current = false; };
    }
    if (!open) {
      wasOpenRef.current = false;
      const timer = window.setTimeout(() => {
        setDraft(null);
        setBusy(null);
        setFormError("");
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  const save = async (asCopy = false) => {
    if (!draft || busy) return;
    setBusy(asCopy ? "copy" : "update");
    setFormError("");
    try {
      const preset = draft.target && !asCopy
        ? await library.update(draft.target.id, {
          name: name.trim(),
          settings: draft.settings,
          ...(pinned === undefined ? {} : { pinned }),
          expectedRevision: draft.target.revision,
        })
        : await library.create({
          id: draft.id,
          name: name.trim(),
          settings: draft.settings,
          pinned: pinned ?? false,
        });
      onSaved?.(preset);
      setDraft(null);
      setBusy(null);
      setFormError("");
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof PresetRequestError && caught.status === 409) {
        void library.refresh();
        void library.refreshPinned();
        setFormError("This preset changed in another session. Your settings and name are still here; save a copy or close and reopen to review the latest version.");
      } else {
        setFormError(caught instanceof TypeError ? "Check your connection and try again." : caught instanceof Error ? caught.message : "Could not save this preset.");
      }
    } finally {
      setBusy(null);
    }
  };

  const title = draft?.target ? "Update this preset?" : pinned ? "Save this Quick Look?" : "Save this preset?";
  const description = draft?.target
    ? "Confirm the name and visual settings to update this saved look."
    : "Confirm this look before saving it to your ChatGPT account. Media, images, subtitles, and track names are excluded.";

  return (
    <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="preset-confirm-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {draft && <form onSubmit={event => { event.preventDefault(); void save(); }} className="preset-form">
          <label>Preset name
            <input autoFocus required maxLength={80} placeholder="e.g. Neon lake" value={name} onChange={event => setName(event.target.value)} disabled={!!busy}/>
          </label>
          <div className="preset-save-summary">
            <span className="preset-color-preview" aria-hidden="true" style={{ background: `linear-gradient(135deg,${draft.settings.primary},${draft.settings.secondary})` }}/>
            <div><strong>{visualModeName(draft.settings.mode)}</strong><p>Colors, motion, audio response, logo layout, and text styling.</p></div>
          </div>
          {formError && <p className="preset-error" role="alert">{formError}</p>}
          {library.signin && <div className="preset-signin-recovery">
            <p>Your sign-in has expired. Close this popup to sign in again.{hasMedia ? " Save your current project first to keep its media and edits." : ""}</p>
            <a className="button button-soft" href={library.signin} target="_top">Sign in with ChatGPT</a>
          </div>}
          <div className="preset-form-actions">
            <button type="button" className="button button-soft" disabled={!!busy} onClick={() => onOpenChange(false)}>Cancel</button>
            {draft.target && <button type="button" className="button button-soft" disabled={!!busy || !name.trim()} onClick={() => { void save(true); }}>
              {busy === "copy" ? "Saving copy…" : "Save as copy"}
            </button>}
            <button className="button export-button" disabled={!!busy || !name.trim()} type="submit">
              {busy ? busy === "copy" ? "Saving copy…" : "Saving…" : draft.target ? "Confirm update" : pinned ? "Save Quick Look" : "Confirm save"}
            </button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>
  );
}
