"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MediaSessionOwner, type MediaSessionEvent, type MediaSessionSnapshot } from "@/lib/media-session";
import type { ProjectContent } from "@/lib/project-file";

export type MediaCommitted = {
  project?: ProjectContent;
  next: File;
  range: [number, number];
  snapshot: MediaSessionSnapshot;
};

export type UseMediaSessionOptions = {
  getMediaHost?: () => HTMLElement | null;
  isBlocked?: () => boolean;
  initialVolume?: number;
  initialLoop?: boolean;
  onEvent?: (event: MediaSessionEvent) => void;
  onCommitted?: (commit: MediaCommitted) => void;
  onError?: (failure: { operation: "load" | "play" | "preview" | "logo" | "background"; error: Error }) => void;
  onNotice?: (message: string) => void;
  onRequestFile?: () => void;
};

export type UseMediaSessionResult = {
  session: MediaSessionOwner;
  snapshot: MediaSessionSnapshot;
  file: File | null;
  duration: number;
  position: number;
  playing: boolean;
  loadingMedia: boolean;
  logoName: string | null;
  logoUrl: string | null;
  backgroundName: string | null;
  backgroundUrl: string | null;
  generation: number;
  requestGeneration: number;
  loadFile: (next: File | undefined, savedRange?: [number, number], project?: ProjectContent) => Promise<boolean>;
  seek: (time: number) => void;
  togglePlay: () => Promise<boolean>;
  previewRange: (range: [number, number]) => Promise<boolean>;
  pollPosition: (force?: boolean) => number;
  changeLogo: (file: File | null) => Promise<boolean>;
  changeBackground: (file: File | null) => Promise<boolean>;
  setVolume: (volume: number) => void;
  setLoop: (looping: boolean) => void;
};

// React StrictMode replays effect cleanup/setup for the same owner. A weak map
// lets that replay invalidate deferred cleanup without reading a mutable ref
// from an effect cleanup closure.
const lifecycleGenerations = new WeakMap<MediaSessionOwner, number>();

export function useMediaSession(options: UseMediaSessionOptions = {}): UseMediaSessionResult {
  const latestOptions = useRef(options);
  useEffect(() => {
    latestOptions.current = options;
  }, [options]);

  // Host and export-lock getters are lifetime capabilities: callers should
  // provide stable callbacks that read their own refs (as the page does).
  const [session] = useState(() => {
    const getMediaHost = options.getMediaHost;
    const isBlocked = options.isBlocked;
    return new MediaSessionOwner({
      getMediaHost: () => getMediaHost?.() ?? null,
      isBlocked: () => isBlocked?.() ?? false,
    });
  });
  const [snapshot, setSnapshot] = useState(() => session.snapshot);
  const [position, setPosition] = useState(0);
  const [loadingMedia, setLoadingMedia] = useState(false);
  useEffect(() => {
    session.setVolume(latestOptions.current.initialVolume ?? 0.7);
    session.setLoop(latestOptions.current.initialLoop ?? false);
    return session.subscribe((event: MediaSessionEvent) => {
      if ("snapshot" in event) setSnapshot(event.snapshot);
      switch (event.type) {
        case "loading":
          setLoadingMedia(event.loading);
          break;
        case "commit":
          setPosition(0);
          latestOptions.current.onCommitted?.({ project: event.project, next: event.next, range: event.range, snapshot: event.snapshot });
          break;
        case "seek":
        case "position":
          setPosition(event.time);
          break;
        case "pause":
        case "ended":
          setPosition(event.time);
          break;
        case "error":
          latestOptions.current.onError?.({ operation: event.operation, error: event.error });
          break;
        case "notice":
          latestOptions.current.onNotice?.(event.message);
          break;
      }
      latestOptions.current.onEvent?.(event);
    });
  }, [session]);

  // Defer disposal one microtask so StrictMode's immediate effect replay can
  // invalidate the cleanup for this same owner.
  useEffect(() => {
    const lifecycle = (lifecycleGenerations.get(session) ?? 0) + 1;
    lifecycleGenerations.set(session, lifecycle);
    return () => {
      queueMicrotask(() => {
        if (lifecycleGenerations.get(session) === lifecycle) session.dispose();
      });
    };
  }, [session]);

  const loadFile = useCallback((next: File | undefined, savedRange?: [number, number], project?: ProjectContent) =>
    session.load(next, { range: savedRange, project }), [session]);
  const seek = useCallback((time: number) => session.seek(time), [session]);
  const togglePlay = useCallback(() => {
    if (!session.snapshot.media) {
      latestOptions.current.onRequestFile?.();
      return Promise.resolve(false);
    }
    return session.togglePlay();
  }, [session]);
  const previewRange = useCallback((range: [number, number]) => session.previewRange(range), [session]);
  const pollPosition = useCallback((force = false) => session.pollPosition(force), [session]);
  const changeLogo = useCallback((file: File | null) => session.changeImage("logo", file), [session]);
  const changeBackground = useCallback((file: File | null) => session.changeImage("background", file), [session]);
  const setVolume = useCallback((volume: number) => session.setVolume(volume), [session]);
  const setLoop = useCallback((looping: boolean) => session.setLoop(looping), [session]);

  return {
    session, snapshot,
    file: snapshot.file,
    duration: snapshot.duration,
    position,
    playing: snapshot.playing,
    loadingMedia,
    logoName: snapshot.logo?.file.name ?? null,
    logoUrl: snapshot.logo?.url ?? null,
    backgroundName: snapshot.background?.file.name ?? null,
    backgroundUrl: snapshot.background?.url ?? null,
    generation: snapshot.generation,
    requestGeneration: session.requestGeneration,
    loadFile, seek, togglePlay, previewRange, pollPosition, changeLogo, changeBackground, setVolume, setLoop,
  };
}
