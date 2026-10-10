import { PROJECT_LIMITS, type ProjectTrack } from "./project-model";
import type { SubtitleCue } from "./subtitles";

export type PlaylistSegment = {
  trackId: string;
  track: ProjectTrack;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
};

export type PlaylistTimeline = {
  segments: PlaylistSegment[];
  duration: number;
};

export type ProjectTimeResolution = {
  trackId: string;
  sourceTime: number;
  projectTime: number;
  segment: PlaylistSegment;
  atEnd: boolean;
};

export type PlaylistClip = {
  trackId: string;
  track: ProjectTrack;
  projectRange: [number, number];
  sourceRange: [number, number];
};

export function buildPlaylistTimeline(tracks: ProjectTrack[]): PlaylistTimeline {
  if (tracks.length > PROJECT_LIMITS.tracks)
    throw new Error(`A playlist can contain up to ${PROJECT_LIMITS.tracks} tracks.`);
  let cursor = 0;
  const segments: PlaylistSegment[] = [];
  for (const track of tracks) {
    const [sourceStart, sourceEnd] = track.range;
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart)
      continue;
    const length = sourceEnd - sourceStart;
    if (!Number.isFinite(length) || !Number.isFinite(cursor + length))
      throw new Error("The playlist is too long to map safely.");
    segments.push({
      trackId: track.id,
      track,
      start: cursor,
      end: cursor + length,
      sourceStart,
      sourceEnd,
    });
    cursor += length;
  }
  return { segments, duration: cursor };
}

/** Map project time through contiguous hard-cut segments into source time. */
export function resolveProjectTime(
  timeline: PlaylistTimeline,
  projectTime: number,
): ProjectTimeResolution | null {
  if (!Number.isFinite(projectTime) || !timeline.segments.length || projectTime < 0) return null;
  const atEnd = projectTime >= timeline.duration;
  const segment = atEnd
    ? timeline.segments[timeline.segments.length - 1]
    : (timeline.segments.find((part) => projectTime < part.end) ?? null);
  if (!segment) return null;
  const clampedProjectTime = Math.max(segment.start, Math.min(projectTime, segment.end));
  const sourceTime = segment.sourceStart + (clampedProjectTime - segment.start);
  return {
    trackId: segment.trackId,
    sourceTime,
    projectTime: clampedProjectTime,
    segment,
    atEnd,
  };
}

/** Intersect a requested project-time range with each source track's trim. */
export function clipProjectRange(
  timeline: PlaylistTimeline,
  range: [number, number],
): PlaylistClip[] {
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const clipStart = Math.max(0, start);
  const clipEnd = Math.min(timeline.duration, end);
  if (clipEnd <= clipStart) return [];
  const clips: PlaylistClip[] = [];
  for (const segment of timeline.segments) {
    const from = Math.max(clipStart, segment.start);
    const to = Math.min(clipEnd, segment.end);
    if (to <= from) continue;
    clips.push({
      trackId: segment.trackId,
      track: segment.track,
      projectRange: [from, to],
      sourceRange: [
        segment.sourceStart + from - segment.start,
        segment.sourceStart + to - segment.start,
      ],
    });
  }
  return clips;
}

/** Rebase source-time captions onto the continuous playlist timeline. */
export function getProjectSubtitles(
  tracks: ProjectTrack[],
  projectRange?: [number, number],
): SubtitleCue[] {
  const timeline = buildPlaylistTimeline(tracks);
  const requestedStart = projectRange ? Math.max(0, projectRange[0]) : 0;
  const requestedEnd = projectRange
    ? Math.min(timeline.duration, projectRange[1])
    : timeline.duration;
  if (
    !Number.isFinite(requestedStart) ||
    !Number.isFinite(requestedEnd) ||
    requestedEnd <= requestedStart
  )
    return [];
  const cues: SubtitleCue[] = [];
  for (const segment of timeline.segments) {
    const projectStart = Math.max(requestedStart, segment.start);
    const projectEnd = Math.min(requestedEnd, segment.end);
    if (projectEnd <= projectStart) continue;
    const sourceStart = segment.sourceStart + projectStart - segment.start;
    const sourceEnd = segment.sourceStart + projectEnd - segment.start;
    for (const cue of segment.track.subtitles) {
      const start = Math.max(sourceStart, cue.start);
      const end = Math.min(sourceEnd, cue.end);
      if (end <= start) continue;
      cues.push({
        id: `${segment.trackId}:${cue.id}`,
        text: cue.text,
        start: segment.start + start - segment.sourceStart,
        end: segment.start + end - segment.sourceStart,
      });
    }
  }
  return cues.sort((first, second) => first.start - second.start || first.end - second.end);
}
