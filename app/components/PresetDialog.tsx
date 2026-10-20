import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Pin,
  PinOff,
  Pencil,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/AlertDialog";
import { PresetSaveDialog } from "@/components/PresetSaveDialog";
import type { PresetLibrary } from "@/hooks/use-presets";
import { PresetStoreError } from "@/lib/persistence/preset-store";
import { visualModeName, type SavedPreset } from "@/lib/visual/presets";
import type { VisualSettings } from "@/lib/visual/visual-settings-model";

type Props = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  settings: VisualSettings;
  library: PresetLibrary;
  currentPreset?: SavedPreset | null;
  onApply: (preset: SavedPreset) => void;
  onSaved?: (preset: SavedPreset) => void;
  onMetadataChanged?: (preset: SavedPreset) => void;
  onDeleted?: (id: string) => void;
  onHelp: () => void;
};

const errorMessage = (caught: unknown, fallback: string) =>
  caught instanceof Error ? caught.message : fallback;

export function PresetDialog({
  open,
  onOpenChange,
  settings,
  library,
  currentPreset = null,
  onApply,
  onSaved,
  onMetadataChanged,
  onDeleted,
  onHelp,
}: Props) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTarget, setSaveTarget] = useState<SavedPreset | null>(null);
  const [rename, setRename] = useState<SavedPreset | null>(null);
  const [renameName, setRenameName] = useState("");
  const [remove, setRemove] = useState<SavedPreset | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const { refresh: refreshLibrary } = library;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void refreshLibrary();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, refreshLibrary]);

  const startSave = (target: SavedPreset | null) => {
    setSaveTarget(target);
    setSaveOpen(true);
  };

  const startRename = (preset: SavedPreset) => {
    setRename(preset);
    setRenameName(preset.name);
    setFormError("");
    setActionError("");
  };

  const refreshAfterConflict = () => {
    void library.refresh();
  };

  const togglePinned = async (preset: SavedPreset) => {
    if (busyId) return;
    setBusyId(preset.id);
    setActionError("");
    try {
      const updated = await library.update(preset.id, {
        pinned: !preset.pinned,
        expectedRevision: preset.revision,
      });
      setNotice(
        updated.pinned
          ? `Added “${updated.name}” to Quick Looks.`
          : `Removed “${updated.name}” from Quick Looks.`,
      );
      if (currentPreset?.id === updated.id) onMetadataChanged?.(updated);
    } catch (caught) {
      if (caught instanceof PresetStoreError && caught.code === "conflict") refreshAfterConflict();
      setActionError(errorMessage(caught, "Could not update this preset."));
    } finally {
      setBusyId(null);
    }
  };

  const movePinned = async (preset: SavedPreset, direction: -1 | 1) => {
    if (busyId) return;
    const index = library.pinnedPresets.findIndex((item) => item.id === preset.id);
    const neighbor = library.pinnedPresets[index + direction];
    if (!neighbor) return;
    setBusyId(preset.id);
    setActionError("");
    try {
      const [moved, shifted] = await library.reorder(preset, neighbor);
      setNotice(`Moved “${moved.name}” ${direction < 0 ? "up" : "down"}.`);
      if (currentPreset?.id === moved.id) onMetadataChanged?.(moved);
      else if (currentPreset?.id === shifted.id) onMetadataChanged?.(shifted);
    } catch (caught) {
      if (caught instanceof PresetStoreError && caught.code === "conflict") refreshAfterConflict();
      setActionError(
        errorMessage(caught, "Could not move this Quick Look. Refresh the list and try again."),
      );
    } finally {
      setBusyId(null);
    }
  };

  const confirmRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rename || busyId) return;
    setBusyId(rename.id);
    setFormError("");
    try {
      const updated = await library.update(rename.id, {
        name: renameName.trim(),
        expectedRevision: rename.revision,
      });
      setRename(null);
      setNotice("Preset renamed.");
      if (currentPreset?.id === updated.id) onMetadataChanged?.(updated);
    } catch (caught) {
      if (caught instanceof PresetStoreError && caught.code === "conflict") refreshAfterConflict();
      setFormError(errorMessage(caught, "Could not rename this preset."));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    if (!remove || busyId) return;
    const deletedId = remove.id;
    setBusyId(deletedId);
    setFormError("");
    setActionError("");
    try {
      await library.remove(deletedId);
      setRemove(null);
      setNotice("Preset deleted.");
      if (currentPreset?.id === deletedId) onDeleted?.(deletedId);
    } catch (caught) {
      setFormError(errorMessage(caught, "Could not delete this preset."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busyId) onOpenChange(value);
        }}
      >
        <DialogContent className="preset-dialog">
          <DialogHeader>
            <div className="dialog-icon">
              <Bookmark size={20} />
            </div>
            <DialogTitle>My presets</DialogTitle>
            <DialogDescription>
              Save your favorite looks in this browser and reuse them on any track.
            </DialogDescription>
          </DialogHeader>
          <div className="preset-library-toolbar">
            <button
              className="button button-soft"
              disabled={library.loading}
              onClick={() => startSave(null)}
            >
              <Save size={17} /> Save as copy
            </button>
            {currentPreset && (
              <button
                className="button button-soft"
                disabled={library.loading}
                onClick={() => startSave(currentPreset)}
              >
                <Pencil size={16} /> Update current
              </button>
            )}
            <label className="preset-search">
              <Search size={17} />
              <input
                aria-label="Search presets"
                placeholder="Search your presets"
                maxLength={80}
                value={library.search}
                onChange={(event) => library.setSearch(event.target.value)}
              />
            </label>
          </div>
          <p className="preset-note">
            Visual settings only. Songs, images, subtitle blocks, and track names stay with your
            project.
          </p>
          {library.error && (
            <div className="preset-error" role="alert">
              <span>{library.error}</span>
              <button
                className="button button-soft"
                onClick={() => {
                  void library.refresh();
                }}
              >
                Try again
              </button>
            </div>
          )}
          {actionError && (
            <div className="preset-error" role="alert">
              <span>{actionError}</span>
            </div>
          )}
          {notice && (
            <p className="preset-status" role="status">
              {notice}
            </p>
          )}
          <div className="preset-list" aria-busy={library.loading}>
            {!library.presets.length && !library.loading && !library.error && (
              <div className="preset-empty">
                <strong>
                  {library.search ? "No matching presets" : "Your first look starts here"}
                </strong>
                <p>
                  {library.search
                    ? "Try another name."
                    : "Choose Save as copy to keep the look currently in your preview."}
                </p>
              </div>
            )}
            {library.presets.map((preset) => {
              const pinnedIndex = preset.pinned
                ? library.pinnedPresets.findIndex((item) => item.id === preset.id)
                : -1;
              return (
                <article className="preset-card" key={preset.id}>
                  <div
                    className="preset-color-preview"
                    aria-hidden="true"
                    style={{
                      background: `linear-gradient(135deg,${preset.settings.primary},${preset.settings.secondary})`,
                    }}
                  >
                    <span style={{ background: preset.settings.background }} />
                  </div>
                  <div className="preset-copy">
                    <strong>{preset.name}</strong>
                    <span>
                      {visualModeName(preset.settings.mode)}
                      {preset.pinned ? " · Quick Look" : ""}
                      {currentPreset?.id === preset.id ? " · Current" : ""}
                    </span>
                  </div>
                  <button
                    className="button button-soft preset-apply"
                    disabled={busyId !== null}
                    onClick={() => {
                      onApply(preset);
                      onOpenChange(false);
                    }}
                  >
                    Apply
                  </button>
                  <div className="preset-actions">
                    <span>
                      {preset.pinned ? "Pinned to Quick Looks" : "Add a Quick Look shortcut"}
                    </span>
                    <button
                      className="preset-icon"
                      aria-label={
                        preset.pinned
                          ? `Remove ${preset.name} from Quick Looks`
                          : `Pin ${preset.name} to Quick Looks`
                      }
                      title={preset.pinned ? "Remove from Quick Looks" : "Add to Quick Looks"}
                      disabled={busyId !== null}
                      onClick={() => {
                        void togglePinned(preset);
                      }}
                    >
                      {preset.pinned ? <PinOff size={17} /> : <Pin size={17} />}
                    </button>
                    {preset.pinned && (
                      <>
                        <button
                          className="preset-icon"
                          aria-label={`Move ${preset.name} up`}
                          title="Move up in Quick Looks"
                          disabled={busyId !== null || pinnedIndex <= 0}
                          onClick={() => {
                            void movePinned(preset, -1);
                          }}
                        >
                          <ArrowUp size={17} />
                        </button>
                        <button
                          className="preset-icon"
                          aria-label={`Move ${preset.name} down`}
                          title="Move down in Quick Looks"
                          disabled={
                            busyId !== null ||
                            pinnedIndex < 0 ||
                            pinnedIndex >= library.pinnedPresets.length - 1
                          }
                          onClick={() => {
                            void movePinned(preset, 1);
                          }}
                        >
                          <ArrowDown size={17} />
                        </button>
                      </>
                    )}
                    <button
                      className="preset-icon"
                      aria-label={`Rename ${preset.name}`}
                      title="Rename"
                      disabled={busyId !== null}
                      onClick={() => startRename(preset)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      className="preset-icon"
                      aria-label={`Delete ${preset.name}`}
                      title="Delete"
                      disabled={busyId !== null}
                      onClick={() => {
                        setRemove(preset);
                        setFormError("");
                        setActionError("");
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              );
            })}
            {library.loading && (
              <p className="preset-status" role="status">
                Loading your presets…
              </p>
            )}
            {library.hasMore && (
              <button
                className="button button-soft preset-more"
                disabled={library.loading}
                onClick={() => {
                  void library.loadMore();
                }}
              >
                Load more
              </button>
            )}
          </div>
          <div className="preset-library-footer">
            <span>Saved in this browser. Storage limits apply.</span>
            <button onClick={onHelp}>How it works</button>
          </div>
        </DialogContent>
      </Dialog>

      <PresetSaveDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        settings={settings}
        library={library}
        target={saveTarget}
        onSaved={(preset) => {
          setNotice(`Saved “${preset.name}”.`);
          onSaved?.(preset);
        }}
      />

      <Dialog
        open={!!rename}
        onOpenChange={(value) => {
          if (!value && !busyId) {
            setRename(null);
            setFormError("");
          }
        }}
      >
        <DialogContent className="preset-confirm-dialog" showCloseButton={!busyId}>
          <DialogHeader>
            <DialogTitle>Rename preset</DialogTitle>
            <DialogDescription>Give this saved look a new name.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              void confirmRename(event);
            }}
            className="preset-form"
          >
            <label>
              Preset name
              <input
                autoFocus
                required
                maxLength={80}
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                disabled={!!busyId}
              />
            </label>
            {formError && (
              <p className="preset-error" role="alert">
                {formError}
              </p>
            )}
            <div className="preset-form-actions">
              <button
                type="button"
                className="button button-soft"
                disabled={!!busyId}
                onClick={() => setRename(null)}
              >
                Cancel
              </button>
              <button
                className="button export-button"
                disabled={!!busyId || !renameName.trim()}
                type="submit"
              >
                {busyId === rename?.id ? "Saving…" : "Save name"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!remove}
        onOpenChange={(value) => {
          if (!value && !busyId) setRemove(null);
        }}
      >
        <AlertDialogContent className="preset-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this preset?</AlertDialogTitle>
            <AlertDialogDescription>
              “{remove?.name}” will be removed from your library. Your current visualizer and
              project stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {formError && (
            <p className="preset-error" role="alert">
              {formError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="button button-soft" disabled={!!busyId}>
              Cancel
            </AlertDialogCancel>
            <button
              className="button preset-delete"
              disabled={!!busyId}
              onClick={() => {
                void confirmRemove();
              }}
            >
              {busyId === remove?.id ? "Deleting…" : "Delete preset"}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
