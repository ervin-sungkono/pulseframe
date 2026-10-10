"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useMediaSession,
  type MediaCommitted,
  type UseMediaSessionOptions,
} from "./use-media-session";
import { useProjectTracks } from "./use-project-tracks";
import {
  createProjectTrack,
  getProjectTrack,
  type ProjectTrack,
  type ProjectTrackPatch,
} from "@/lib/project-model";
import { buildPlaylistTimeline, resolveProjectTime } from "@/lib/playlist-timeline";
import type { ProjectContent } from "@/lib/project-file";
import { shiftReleaseRecipe, type ReleaseRecipe } from "@/lib/release-recipe";

/** Connects the project document to the resource owner. Track metadata has one owner. */
export function useStudioProject(options: UseMediaSessionOptions) {
  const activationRef = useRef<ProjectTrack | null>(null);
  const tracksRef = useRef<ReturnType<typeof useProjectTracks> | null>(null);
  const [playlistPlaying, setPlaylistPlaying] = useState(false);
  const playlistPlayingRef = useRef(false);
  const playbackGeneration = useRef(0);
  const advancingRef = useRef<number | null>(null);
  const [selection, setSelection] = useState<{ key: string; range: [number, number] } | null>(null);
  const [savedRecipe, setSavedRecipe] = useState<{ key: string; recipe: ReleaseRecipe } | null>(
    null,
  );
  const media = useMediaSession({
    ...options,
    onCommitted: (commit: MediaCommitted) => {
      if (activationRef.current?.file === commit.next && !commit.project) return;
      playlistPlayingRef.current = false;
      setPlaylistPlaying(false);
      playbackGeneration.current++;
      const project = commit.project;
      const track = createProjectTrack(commit.next, commit.snapshot.duration);
      const restored = project?.tracks?.length
        ? project.tracks
        : [
            {
              ...track,
              range: commit.range,
              title: project?.settings.trackTitle ?? track.title,
              artist: project?.settings.trackArtist ?? "",
              subtitles: project?.subtitles ?? [],
              artwork: project?.artwork ?? null,
            },
          ];
      tracksRef.current?.replaceTracks(restored, project?.activeTrackId ?? restored[0].id);
      setSelection(
        project?.globalExportRange
          ? {
              key: JSON.stringify(restored.map((track) => [track.id, track.range])),
              range: project.globalExportRange,
            }
          : null,
      );
      setSavedRecipe(
        project?.releaseRecipe
          ? {
              key: JSON.stringify(restored.map((track) => [track.id, track.range])),
              recipe: project.releaseRecipe,
            }
          : null,
      );
      options.onCommitted?.(commit);
    },
  });

  const tracks = useProjectTracks({
    isBlocked: options.isBlocked,
    activateTrack: async (track) => {
      activationRef.current = track;
      media.session.pause();
      // Preserve the document and original files, release only derived PCM.
      media.suspendPreparedSound();
      const current = media.session.snapshot;
      try {
        return await media.loadFile(track.file, track.range, undefined, {
          projectAssets: {
            logo: current.logo?.file ?? null,
            background: current.background?.file ?? null,
            artwork: track.artwork,
          },
        });
      } finally {
        if (activationRef.current === track) activationRef.current = null;
      }
    },
  });
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  const activeTrack = getProjectTrack(tracks.tracks, tracks.activeTrackId);
  const timeline = buildPlaylistTimeline(tracks.tracks);
  const timelineKey = JSON.stringify(tracks.tracks.map((track) => [track.id, track.range]));
  const range: [number, number] =
    tracks.tracks.length > 1
      ? selection?.key === timelineKey
        ? selection.range
        : [0, timeline.duration]
      : (activeTrack?.range ?? [0, 0]);
  const exportDuration = tracks.tracks.length > 1 ? timeline.duration : media.duration;
  const globalReleaseRecipe = savedRecipe?.key === timelineKey ? savedRecipe.recipe : null;
  const releaseRecipe = globalReleaseRecipe
    ? shiftReleaseRecipe(
        globalReleaseRecipe,
        tracks.tracks.length === 1 ? (activeTrack?.range[0] ?? 0) : 0,
      )
    : null;
  const setReleaseRecipe = (recipe: ReleaseRecipe) => {
    if (!options.isBlocked?.())
      setSavedRecipe({
        key: timelineKey,
        recipe: shiftReleaseRecipe(
          recipe,
          tracks.tracks.length === 1 ? -(activeTrack?.range[0] ?? 0) : 0,
        ),
      });
  };

  const updateTrack = useCallback(
    async (id: string, patch: ProjectTrackPatch) => {
      if (options.isBlocked?.()) return;
      if (id === tracks.activeTrackId && Object.hasOwn(patch, "artwork")) {
        if (!(await media.changeArtwork(patch.artwork ?? null))) return;
      }
      tracks.updateTrack(id, patch);
    },
    [media, options, tracks],
  );
  const setRange = (next: [number, number]) => {
    if (options.isBlocked?.()) return;
    if (tracks.tracks.length > 1) setSelection({ key: timelineKey, range: next });
    else if (activeTrack) tracks.updateTrack(activeTrack.id, { range: next });
  };
  const stopPlaylist = useCallback(() => {
    if (playlistPlayingRef.current) media.session.pause();
    playlistPlayingRef.current = false;
    setPlaylistPlaying(false);
    playbackGeneration.current++;
  }, [media.session]);
  const activateTrack = async (id: string) => {
    stopPlaylist();
    return tracks.activateTrack(id);
  };
  const previewProjectRange = async (requested: [number, number]) => {
    if (options.isBlocked?.()) return false;
    if (tracks.tracks.length < 2) return media.previewRange(requested);
    stopPlaylist();
    const generation = playbackGeneration.current;
    const target = resolveProjectTime(timeline, requested[0]);
    if (!target) return false;
    if (!(await tracks.activateTrack(target.trackId))) return false;
    if (generation !== playbackGeneration.current || options.isBlocked?.()) return false;
    // Playback advances through hard cuts; export-range end is enforced below.
    playlistEnd.current = requested[1];
    playlistPlayingRef.current = true;
    setPlaylistPlaying(true);
    media.seek(target.sourceTime);
    return media.togglePlay();
  };
  const playlistEnd = useRef(Infinity);
  useEffect(() => {
    if (!playlistPlaying || !activeTrack) return;
    const generation = playbackGeneration.current;
    const advance = async () => {
      if (
        advancingRef.current === generation ||
        !playlistPlayingRef.current ||
        options.isBlocked?.()
      )
        return;
      const index = tracks.tracks.findIndex((track) => track.id === activeTrack.id);
      const next = tracks.tracks.slice(index + 1).find((track) => track.range[1] > track.range[0]);
      const segment = timeline.segments.find((part) => part.trackId === next?.id);
      if (!next || !segment || segment.start >= playlistEnd.current) {
        media.session.pause();
        stopPlaylist();
        return;
      }
      advancingRef.current = generation;
      try {
        if (await tracks.activateTrack(next.id)) {
          if (generation !== playbackGeneration.current || !playlistPlayingRef.current) return;
          media.seek(next.range[0]);
          await media.togglePlay();
        } else stopPlaylist();
      } finally {
        if (advancingRef.current === generation) advancingRef.current = null;
      }
    };
    const unsubscribe = media.session.subscribe((event) => {
      if (event.type === "ended") void advance();
    });
    const timer = setInterval(() => {
      if (!playlistPlayingRef.current || advancingRef.current === generation) return;
      const segment = timeline.segments.find((part) => part.trackId === activeTrack.id);
      const time = media.session.snapshot.media?.currentTime ?? 0;
      if (segment && segment.start + time - activeTrack.range[0] >= playlistEnd.current) {
        media.session.pause();
        stopPlaylist();
      } else if (time >= activeTrack.range[1] - 0.015) void advance();
    }, 40);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [activeTrack, media, options, playlistPlaying, stopPlaylist, timeline, tracks]);
  const removeTrack = async (id: string) => {
    if (options.isBlocked?.()) return;
    stopPlaylist();
    if (id === tracks.activeTrackId) {
      const replacement = tracks.tracks.find((track) => track.id !== id);
      if (replacement) {
        if (!(await tracks.activateTrack(replacement.id))) return;
      } else if (!media.clearMedia()) return;
    }
    tracks.removeTrack(id);
  };
  const loadFile = (
    file: File | undefined,
    savedRange?: [number, number],
    project?: ProjectContent,
  ) => {
    stopPlaylist();
    activationRef.current = null;
    return media.loadFile(file, savedRange, project);
  };
  return {
    media,
    tracks,
    activeTrack,
    timeline,
    exportDuration,
    range,
    setRange,
    updateTrack,
    activateTrack,
    removeTrack,
    loadFile,
    previewProjectRange,
    playlistPlaying,
    stopPlaylist,
    releaseRecipe,
    globalReleaseRecipe,
    setReleaseRecipe,
  };
}
