import type { VisualSettings } from "./visual-settings-model";
import type { SubtitleCue } from "./subtitles";

export const PROJECT_LIMITS = {
  manifestBytes: 2 * 1024 * 1024,
  legacyManifestBytes: 256 * 1024,
  tracks: 20,
  cuesPerTrack: 500,
  trackIdLength: 80,
  titleLength: 120,
  artistLength: 120,
} as const;

export type ProjectTrack = {
  id: string;
  file: File;
  duration: number;
  range: [number, number];
  title: string;
  artist: string;
  subtitles: SubtitleCue[];
  artwork: File | null;
};

export type ProjectTrackPatch = Partial<
  Pick<ProjectTrack, "range" | "title" | "artist" | "subtitles" | "artwork">
>;

let fallbackTrackId = 0;

export function createProjectTrack(file: File, duration: number, id = newTrackId()): ProjectTrack {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("The media file has no usable duration.");
  return validateProjectTrack({
    id,
    file,
    duration,
    range: [0, duration],
    title: file.name.replace(/\.[^.]+$/, "").slice(0, PROJECT_LIMITS.titleLength),
    artist: "",
    subtitles: [],
    artwork: null,
  });
}

export function newTrackId() {
  const id = globalThis.crypto?.randomUUID?.();
  if (id) return id;
  fallbackTrackId += 1;
  return `track-${Date.now().toString(36)}-${fallbackTrackId.toString(36)}`;
}

export function validateProjectTrack(track: ProjectTrack): ProjectTrack {
  if (!track.id || track.id.length > PROJECT_LIMITS.trackIdLength)
    throw new Error("A track has an invalid ID.");
  if (!Number.isFinite(track.duration) || track.duration <= 0)
    throw new Error("A track has an invalid duration.");
  if (
    !Array.isArray(track.range) ||
    track.range.length !== 2 ||
    !track.range.every(Number.isFinite) ||
    track.range[0] < 0 ||
    track.range[1] < track.range[0] ||
    track.range[1] > track.duration
  ) {
    throw new Error("A track has an invalid trim range.");
  }
  if (typeof track.title !== "string" || track.title.length > PROJECT_LIMITS.titleLength)
    throw new Error("A track title is too long.");
  if (typeof track.artist !== "string" || track.artist.length > PROJECT_LIMITS.artistLength)
    throw new Error("A track artist is too long.");
  if (!Array.isArray(track.subtitles) || track.subtitles.length > PROJECT_LIMITS.cuesPerTrack)
    throw new Error("A track has too many captions.");
  for (const cue of track.subtitles) {
    if (
      !cue.id ||
      cue.id.length > 80 ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < 0 ||
      cue.end <= cue.start ||
      cue.end > track.duration ||
      typeof cue.text !== "string" ||
      cue.text.length > 600
    ) {
      throw new Error("A track has an invalid caption.");
    }
  }
  return {
    ...track,
    range: [track.range[0], track.range[1]],
    subtitles: track.subtitles.map((cue) => ({ ...cue })),
  };
}

export function updateProjectTrack(track: ProjectTrack, patch: ProjectTrackPatch): ProjectTrack {
  return validateProjectTrack({ ...track, ...patch });
}

export function resolveTrackMetadata<T extends VisualSettings>(
  settings: T,
  track: ProjectTrack,
): T {
  return { ...settings, trackTitle: track.title, trackArtist: track.artist };
}

export function getProjectTrack(tracks: ProjectTrack[], id: string | null | undefined) {
  return tracks.find((track) => track.id === id) ?? null;
}
