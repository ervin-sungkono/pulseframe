import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Disc3,
  ImagePlus,
  Pencil,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import "@/app/artist-profiles.css";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type {
  ArtistProfileApplication,
  ArtistProfileAssets,
  ArtistProfileSummary,
} from "@/lib/artist-profile";
import { artistProfileStyleFromSettings } from "@/lib/artist-profile";
import { createArtistProfileId, ArtistProfileStoreError } from "@/lib/artist-profile-store";
import type { ArtistProfileLibrary } from "@/hooks/use-artist-profiles";
import type { VisualSettings } from "@/lib/visual-settings-model";

type Props = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  settings: VisualSettings;
  /** Current browser-local image blobs. Cover art is copied only after the explicit checkbox choice. */
  currentAssets?: ArtistProfileAssets;
  defaultArtist?: string;
  library: ArtistProfileLibrary;
  onApply: (profile: ArtistProfileApplication) => void | Promise<void>;
};

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function ArtistProfileDialog({
  open,
  onOpenChange,
  settings,
  currentAssets = {},
  defaultArtist = settings.trackArtist,
  library,
  onApply,
}: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [saveTarget, setSaveTarget] = useState<ArtistProfileSummary | null>(null);
  const [profileName, setProfileName] = useState("");
  const [artistText, setArtistText] = useState(defaultArtist);
  const [includeArtwork, setIncludeArtwork] = useState(false);
  const [applyDefaultArtist, setApplyDefaultArtist] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ArtistProfileSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [stableSaveId, setStableSaveId] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const { refresh: refreshLibrary } = library;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void refreshLibrary(), 0);
    return () => window.clearTimeout(timer);
  }, [open, refreshLibrary]);

  const startSave = (target: ArtistProfileSummary | null) => {
    setSaveTarget(target);
    setProfileName(target?.name ?? "");
    setArtistText(target?.defaultArtist ?? defaultArtist);
    setIncludeArtwork(false);
    setStableSaveId(target ? "" : createArtistProfileId());
    setFormError("");
    setActionError("");
    setNotice("");
    setFormOpen(true);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyId) return;
    setFormError("");
    setBusyId(saveTarget?.id ?? stableSaveId);
    try {
      const previous = saveTarget ? await library.get(saveTarget.id) : null;
      if (saveTarget && !previous)
        throw new ArtistProfileStoreError("This profile no longer exists.", "missing");
      const assets: ArtistProfileAssets = {
        ...(currentAssets.logo
          ? { logo: currentAssets.logo }
          : previous?.assets.logo
            ? { logo: previous.assets.logo }
            : {}),
        ...(currentAssets.background
          ? { background: currentAssets.background }
          : previous?.assets.background
            ? { background: previous.assets.background }
            : {}),
        ...(includeArtwork
          ? currentAssets.artwork
            ? { artwork: currentAssets.artwork }
            : {}
          : previous?.assets.artwork
            ? { artwork: previous.assets.artwork }
            : {}),
      };
      const draft = {
        name: profileName,
        defaultArtist: artistText,
        style: artistProfileStyleFromSettings(settings),
        assets,
      };
      if (saveTarget) {
        await library.update(saveTarget.id, saveTarget.revision, draft);
        setNotice(`Updated “${profileName.trim()}”.`);
      } else {
        await library.create(draft, stableSaveId || createArtistProfileId());
        setNotice(`Saved “${profileName.trim()}”.`);
      }
      setFormOpen(false);
      setSaveTarget(null);
    } catch (caught) {
      if (caught instanceof ArtistProfileStoreError && caught.code === "conflict")
        void library.refresh();
      setFormError(message(caught, "Could not save this artist profile."));
    } finally {
      setBusyId(null);
    }
  };

  const applyProfile = async (summary: ArtistProfileSummary) => {
    if (busyId) return;
    setBusyId(summary.id);
    setActionError("");
    try {
      const profile = await library.get(summary.id);
      if (!profile) throw new ArtistProfileStoreError("This profile no longer exists.", "missing");
      await onApply({
        id: profile.id,
        name: profile.name,
        defaultArtist: profile.defaultArtist,
        applyDefaultArtist,
        style: profile.style,
        assets: profile.assets,
      });
      setNotice(`Applied “${profile.name}”.`);
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ArtistProfileStoreError && caught.code === "conflict")
        void library.refresh();
      setActionError(message(caught, "Could not apply this artist profile."));
    } finally {
      setBusyId(null);
    }
  };

  const exportProfile = async (profile: ArtistProfileSummary) => {
    if (busyId) return;
    setBusyId(profile.id);
    setActionError("");
    try {
      const file = await library.exportFile(profile.id);
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeFilename(profile.name)}.pfartist`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Exported “${profile.name}”.`);
    } catch (caught) {
      setActionError(message(caught, "Could not export this artist profile."));
    } finally {
      setBusyId(null);
    }
  };

  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busyId) return;
    setBusyId("import");
    setActionError("");
    try {
      const imported = await library.importFile(file);
      setNotice(`Imported “${imported.name}”.`);
    } catch (caught) {
      setActionError(message(caught, "Could not import this artist profile."));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || busyId) return;
    setBusyId(deleteTarget.id);
    setActionError("");
    try {
      await library.remove(deleteTarget);
      setNotice(`Deleted “${deleteTarget.name}”.`);
      setDeleteTarget(null);
    } catch (caught) {
      if (caught instanceof ArtistProfileStoreError && caught.code === "conflict")
        void library.refresh();
      setActionError(message(caught, "Could not delete this profile."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(value) => !busyId && onOpenChange(value)}>
        <DialogContent className="artist-profile-dialog">
          <DialogHeader>
            <div className="artist-profile-dialog-icon">
              <UserRound size={20} />
            </div>
            <DialogTitle>Artist profiles</DialogTitle>
            <DialogDescription>
              Reuse your visual identity across projects. Profiles stay in this browser and can be
              exported as a portable file.
            </DialogDescription>
          </DialogHeader>

          <div className="artist-profile-toolbar">
            <button
              type="button"
              className="button button-soft"
              disabled={library.loading || Boolean(busyId)}
              onClick={() => startSave(null)}
            >
              <ImagePlus size={16} /> Save current profile
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={library.loading || Boolean(busyId)}
              onClick={() => importInput.current?.click()}
            >
              <ArrowUpFromLine size={16} /> Import
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".pfartist,application/x-pulseframe-artist-profile"
              className="artist-profile-file-input"
              aria-label="Import artist profile file"
              onChange={importProfile}
            />
            <label className="artist-profile-search">
              <Search size={17} />
              <input
                aria-label="Search artist profiles"
                placeholder="Search profiles"
                maxLength={80}
                value={library.search}
                onChange={(event) => library.setSearch(event.target.value)}
              />
            </label>
          </div>

          <div className="artist-profile-apply-option">
            <label>
              <input
                type="checkbox"
                checked={applyDefaultArtist}
                onChange={(event) => setApplyDefaultArtist(event.target.checked)}
              />
              Also use the profile’s default artist text on this track
            </label>
            <p>Applying a profile keeps this track’s title, audio, artwork and captions intact.</p>
          </div>

          {formOpen && (
            <form className="artist-profile-form" onSubmit={saveProfile}>
              <div className="artist-profile-form-heading">
                <Pencil size={16} />
                <strong>
                  {saveTarget ? `Update ${saveTarget.name}` : "Save a reusable profile"}
                </strong>
              </div>
              <div className="artist-profile-form-fields">
                <label>
                  Profile name
                  <input
                    autoFocus
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    maxLength={80}
                    required
                    placeholder="Artist or brand name"
                  />
                </label>
                <label>
                  Default artist text
                  <input
                    value={artistText}
                    onChange={(event) => setArtistText(event.target.value)}
                    maxLength={120}
                    placeholder="Artist name shown on a track"
                  />
                </label>
              </div>
              <label
                className={`artist-profile-artwork-choice${currentAssets.artwork ? "" : " is-unavailable"}`}
              >
                <input
                  type="checkbox"
                  checked={includeArtwork}
                  disabled={!currentAssets.artwork}
                  onChange={(event) => setIncludeArtwork(event.target.checked)}
                />
                Include the current release artwork as a reusable image
                {!currentAssets.artwork && <span>No current artwork is available</span>}
              </label>
              {formError && (
                <p className="artist-profile-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="artist-profile-form-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={Boolean(busyId)}
                  onClick={() => setFormOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="button button-soft" disabled={Boolean(busyId)}>
                  <Check size={15} /> {saveTarget ? "Update profile" : "Save profile"}
                </button>
              </div>
            </form>
          )}

          {actionError && (
            <p className="artist-profile-error" role="alert">
              {actionError}
            </p>
          )}
          {notice && !formOpen && (
            <p className="artist-profile-notice" role="status">
              {notice}
            </p>
          )}
          {library.error && !actionError && (
            <p className="artist-profile-error" role="status">
              {library.error}
            </p>
          )}

          <div className="artist-profile-list" aria-live="polite">
            {library.loading ? (
              <p className="artist-profile-empty">Loading profiles…</p>
            ) : library.profiles.length === 0 ? (
              <div className="artist-profile-empty-state">
                <Disc3 size={22} />
                <strong>{library.search ? "No matching profiles" : "No saved profiles yet"}</strong>
                <p>Save a profile to reuse its colors, image assets and text layout.</p>
              </div>
            ) : (
              library.profiles.map((profile) => {
                const busy = busyId === profile.id;
                return (
                  <article className="artist-profile-row" key={profile.id}>
                    <div
                      className="artist-profile-swatch"
                      style={{
                        background: `linear-gradient(140deg, ${profile.style.palette.primary}, ${profile.style.palette.secondary} 52%, ${profile.style.palette.background})`,
                      }}
                    >
                      {profile.defaultArtist.slice(0, 1).toLocaleUpperCase() || (
                        <UserRound size={16} />
                      )}
                    </div>
                    <div className="artist-profile-row-copy">
                      <strong>{profile.name}</strong>
                      <span>{profile.defaultArtist || "No default artist text"}</span>
                      <div className="artist-profile-swatches" aria-label="Profile colors">
                        {[
                          profile.style.palette.primary,
                          profile.style.palette.secondary,
                          profile.style.palette.background,
                        ].map((color) => (
                          <i key={color} style={{ backgroundColor: color }} />
                        ))}
                      </div>
                    </div>
                    <div className="artist-profile-row-actions">
                      <button
                        type="button"
                        className="button button-soft"
                        disabled={Boolean(busyId)}
                        onClick={() => void applyProfile(profile)}
                      >
                        {busy ? "Applying…" : "Apply"}
                      </button>
                      <button
                        type="button"
                        className="artist-profile-icon-action"
                        aria-label={`Update ${profile.name} from current branding`}
                        title="Update from current branding"
                        disabled={Boolean(busyId)}
                        onClick={() => startSave(profile)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="artist-profile-icon-action"
                        aria-label={`Export ${profile.name}`}
                        title="Export profile"
                        disabled={Boolean(busyId)}
                        onClick={() => void exportProfile(profile)}
                      >
                        <ArrowDownToLine size={15} />
                      </button>
                      <button
                        type="button"
                        className="artist-profile-icon-action artist-profile-delete"
                        aria-label={`Delete ${profile.name}`}
                        title="Delete profile"
                        disabled={Boolean(busyId)}
                        onClick={() => setDeleteTarget(profile)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
          <p className="artist-profile-portability-note">
            Browser storage can be cleared by the device. Export profile files to keep a portable
            copy.
          </p>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => !value && setDeleteTarget(null)}
      >
        <AlertDialogContent className="artist-profile-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this artist profile?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” and its saved image assets will be removed from this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>Keep profile</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyId)}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete profile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9 _-]/gi, "")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "artist-profile"
  );
}
