"use client";

import { useRef } from "react";
import { ArrowDown, ArrowUp, ImagePlus, ListMusic, Plus, Trash2 } from "lucide-react";
import type { ProjectTrack, ProjectTrackPatch } from "@/lib/project-model";
import "@/app/playlist.css";

export type PlaylistPanelProps = {
  tracks: ProjectTrack[];
  selectedTrackId: string | null;
  activeTrackId: string | null;
  disabled?: boolean;
  importing?: boolean;
  importError?: string;
  onAddFiles: (files: File[]) => void | Promise<unknown>;
  onSelectTrack: (id: string) => void;
  onActivateTrack: (id: string) => void | Promise<unknown>;
  onUpdateTrack: (id: string, patch: ProjectTrackPatch) => void;
  onMoveTrack: (id: string, direction: -1 | 1) => void;
  onRemoveTrack: (id: string) => void;
};

const secondsLabel = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
};

export function PlaylistPanel({
  tracks,
  selectedTrackId,
  activeTrackId,
  disabled = false,
  importing = false,
  importError = "",
  onAddFiles,
  onSelectTrack,
  onActivateTrack,
  onUpdateTrack,
  onMoveTrack,
  onRemoveTrack,
}: PlaylistPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const artworkInput = useRef<HTMLInputElement>(null);
  const selected = tracks.find((track) => track.id === selectedTrackId) ?? null;

  const addFiles = (files: FileList | null) => {
    if (files?.length) void Promise.resolve(onAddFiles(Array.from(files))).catch(() => {});
    if (fileInput.current) fileInput.current.value = "";
  };
  const updateNumber = (key: "start" | "end", value: string) => {
    if (!selected) return;
    if (!value.trim()) return;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return;
    const minimum = Math.min(0.001, selected.duration);
    const safe = Math.max(0, Math.min(selected.duration, amount));
    const safeStart = Math.min(safe, selected.duration - minimum);
    const safeEnd = Math.max(minimum, safe);
    const range: [number, number] =
      key === "start"
        ? [safeStart, Math.max(safeStart + minimum, selected.range[1])]
        : [Math.min(selected.range[0], safeEnd - minimum), safeEnd];
    onUpdateTrack(selected.id, { range });
  };

  return (
    <section className="playlist-panel" aria-label="Playlist">
      <div className="playlist-panel-heading">
        <div>
          <p className="playlist-eyebrow">Project tracks</p>
          <h2>Playlist</h2>
        </div>
        <span className="playlist-count">{tracks.length} / 20</span>
      </div>

      <input
        ref={fileInput}
        className="playlist-hidden-input"
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.mp4,.mov,.webm,.m4v"
        multiple
        onChange={(event) => addFiles(event.currentTarget.files)}
        aria-label="Add media tracks"
      />
      <button
        className="playlist-add-button"
        type="button"
        disabled={disabled || importing || tracks.length >= 20}
        onClick={() => fileInput.current?.click()}
      >
        <Plus size={17} />
        {importing ? "Reading track details…" : "Add tracks"}
      </button>

      {importError ? (
        <p className="playlist-error" role="alert">
          {importError}
        </p>
      ) : null}

      {tracks.length ? (
        <ol className="playlist-track-list">
          {tracks.map((track, index) => {
            const selectedRow = track.id === selectedTrackId;
            const active = track.id === activeTrackId;
            return (
              <li
                key={track.id}
                className={`playlist-track${selectedRow ? " is-selected" : ""}${active ? " is-active" : ""}`}
              >
                <button
                  className="playlist-track-select"
                  type="button"
                  onClick={() => onSelectTrack(track.id)}
                  aria-pressed={selectedRow}
                  aria-label={`Select track ${index + 1}: ${track.title || track.file.name}`}
                >
                  <span className="playlist-track-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="playlist-track-copy">
                    <strong>{track.title || track.file.name}</strong>
                    <span>{track.artist || track.file.name}</span>
                  </span>
                  <span className="playlist-track-duration">
                    {secondsLabel(track.range[1] - track.range[0])}
                  </span>
                </button>
                <div className="playlist-row-actions">
                  <button
                    type="button"
                    className="playlist-icon-button"
                    aria-label={`Move track ${index + 1} up`}
                    disabled={disabled || index === 0}
                    onClick={() => onMoveTrack(track.id, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="playlist-icon-button"
                    aria-label={`Move track ${index + 1} down`}
                    disabled={disabled || index === tracks.length - 1}
                    onClick={() => onMoveTrack(track.id, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    className="playlist-icon-button is-remove"
                    aria-label={`Remove track ${index + 1}`}
                    disabled={disabled}
                    onClick={() => onRemoveTrack(track.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="playlist-empty">
          <ListMusic size={22} />
          <p>Add media files to build a continuous project.</p>
        </div>
      )}

      {selected ? (
        <div className="playlist-track-editor">
          <div className="playlist-editor-heading">
            <div>
              <p className="playlist-eyebrow">Selected track</p>
              <h3>{selected.title || selected.file.name}</h3>
            </div>
            <button
              type="button"
              className={`playlist-activate${activeTrackId === selected.id ? " is-current" : ""}`}
              disabled={disabled || activeTrackId === selected.id}
              onClick={() => void Promise.resolve(onActivateTrack(selected.id)).catch(() => {})}
            >
              {activeTrackId === selected.id ? "In editor" : "Activate"}
            </button>
          </div>
          <label className="playlist-field">
            <span>Track title</span>
            <input
              value={selected.title}
              maxLength={120}
              disabled={disabled}
              onChange={(event) => onUpdateTrack(selected.id, { title: event.currentTarget.value })}
            />
          </label>
          <label className="playlist-field">
            <span>Artist</span>
            <input
              value={selected.artist}
              maxLength={120}
              disabled={disabled}
              onChange={(event) =>
                onUpdateTrack(selected.id, { artist: event.currentTarget.value })
              }
            />
          </label>
          <div className="playlist-trim-fields">
            <label className="playlist-field">
              <span>Start (seconds)</span>
              <input
                type="number"
                min={0}
                max={selected.duration - Math.min(0.001, selected.duration)}
                step={0.1}
                value={selected.range[0]}
                disabled={disabled}
                onChange={(event) => updateNumber("start", event.currentTarget.value)}
              />
            </label>
            <label className="playlist-field">
              <span>End (seconds)</span>
              <input
                type="number"
                min={selected.range[0] + Math.min(0.001, selected.duration)}
                max={selected.duration}
                step={0.1}
                value={selected.range[1]}
                disabled={disabled}
                onChange={(event) => updateNumber("end", event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="playlist-artwork-row">
            <span>{selected.artwork?.name ?? "No track artwork"}</span>
            <input
              ref={artworkInput}
              className="playlist-hidden-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Choose track artwork"
              onChange={(event) => {
                const artwork = event.currentTarget.files?.[0] ?? null;
                if (artwork) onUpdateTrack(selected.id, { artwork });
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              className="playlist-artwork-button"
              disabled={disabled}
              onClick={() => artworkInput.current?.click()}
            >
              <ImagePlus size={15} />
              Artwork
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
