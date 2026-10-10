"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROJECT_LIMITS,
  createProjectTrack,
  updateProjectTrack,
  validateProjectTrack,
  type ProjectTrack,
  type ProjectTrackPatch,
} from "@/lib/project-model";

export type UseProjectTracksOptions = {
  initialTracks?: ProjectTrack[];
  activeTrackId?: string | null;
  selectedTrackId?: string | null;
  activateTrack?: (track: ProjectTrack) => Promise<boolean | void> | boolean | void;
  onChange?: (tracks: ProjectTrack[], activeTrackId: string | null) => void;
  durationForFile?: (file: File) => Promise<number>;
  isBlocked?: () => boolean;
};

type ProjectTrackState = {
  tracks: ProjectTrack[];
  activeTrackId: string | null;
  selectedTrackId: string | null;
  importing: boolean;
  importError: string;
};

export type UseProjectTracksResult = ProjectTrackState & {
  canAddFiles: boolean;
  addFiles: (files: File[]) => Promise<ProjectTrack[]>;
  selectTrack: (id: string | null) => void;
  activateTrack: (id: string) => Promise<boolean>;
  updateTrack: (id: string, patch: ProjectTrackPatch) => void;
  reorderTrack: (id: string, toIndex: number) => void;
  moveTrack: (id: string, direction: -1 | 1) => void;
  removeTrack: (id: string) => void;
  replaceTracks: (tracks: ProjectTrack[], activeTrackId?: string | null) => boolean;
  upsertActiveTrack: (track: ProjectTrack, activate?: boolean) => boolean;
};

function initialState(options: UseProjectTracksOptions): ProjectTrackState {
  const tracks = (options.initialTracks ?? []).map((track) => validateProjectTrack(track));
  if (tracks.length > PROJECT_LIMITS.tracks)
    throw new Error("A project can contain up to 20 tracks.");
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length)
    throw new Error("A project contains duplicate track IDs.");
  const firstId = tracks[0]?.id ?? null;
  const activeTrackId = options.activeTrackId === undefined ? firstId : options.activeTrackId;
  const selectedTrackId =
    options.selectedTrackId === undefined ? activeTrackId : options.selectedTrackId;
  return {
    tracks,
    activeTrackId: tracks.some((track) => track.id === activeTrackId) ? activeTrackId : null,
    selectedTrackId: tracks.some((track) => track.id === selectedTrackId) ? selectedTrackId : null,
    importing: false,
    importError: "",
  };
}

export async function inspectProjectMediaDuration(file: File): Promise<number> {
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [audioTrack, videoTrack] = await Promise.all([
      input.getPrimaryAudioTrack(),
      input.getPrimaryVideoTrack(),
    ]);
    if (!audioTrack && !videoTrack)
      throw new Error(`Could not find a playable track in “${file.name}”.`);
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error(`Could not read a usable duration from “${file.name}”.`);
    return duration;
  } finally {
    input.dispose();
  }
}

export function useProjectTracks(options: UseProjectTracksOptions = {}): UseProjectTracksResult {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const [state, setState] = useState(() => initialState(options));
  const stateRef = useRef(state);
  const activationRef = useRef(0);
  const pendingActivationRef = useRef<{ token: number; id: string } | null>(null);
  const importRef = useRef(false);
  const importGenerationRef = useRef(0);
  const projectGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activationRef.current += 1;
    };
  }, []);

  const commit = useCallback((update: (current: ProjectTrackState) => ProjectTrackState) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
    optionsRef.current.onChange?.(next.tracks, next.activeTrackId);
    return next;
  }, []);

  const invalidateActivation = useCallback((id?: string) => {
    if (id && pendingActivationRef.current?.id !== id) return;
    activationRef.current += 1;
    pendingActivationRef.current = null;
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (optionsRef.current.isBlocked?.()) throw new Error("Tracks are locked during export.");
      if (importRef.current) throw new Error("A track import is already in progress.");
      if (!files.length) return [];
      const current = stateRef.current;
      const available = PROJECT_LIMITS.tracks - current.tracks.length;
      if (available <= 0 || files.length > available) {
        const error = new Error("A project can contain up to 20 tracks.");
        if (mountedRef.current) commit((value) => ({ ...value, importError: error.message }));
        throw error;
      }
      importRef.current = true;
      const importGeneration = ++importGenerationRef.current;
      const projectGeneration = projectGenerationRef.current;
      commit((value) => ({ ...value, importing: true, importError: "" }));
      try {
        const imported: ProjectTrack[] = [];
        for (const file of files) {
          if (
            optionsRef.current.isBlocked?.() ||
            projectGenerationRef.current !== projectGeneration ||
            importGenerationRef.current !== importGeneration
          ) {
            return [];
          }
          const duration = await (
            optionsRef.current.durationForFile ?? inspectProjectMediaDuration
          )(file);
          if (
            !mountedRef.current ||
            optionsRef.current.isBlocked?.() ||
            projectGenerationRef.current !== projectGeneration ||
            importGenerationRef.current !== importGeneration
          )
            return [];
          imported.push(createProjectTrack(file, duration));
        }
        const currentTracks = stateRef.current.tracks;
        if (currentTracks.length + imported.length > PROJECT_LIMITS.tracks)
          throw new Error("A project can contain up to 20 tracks.");
        commit((value) => {
          const tracks = [...value.tracks, ...imported];
          const selectedTrackId = value.selectedTrackId ?? imported[0]?.id ?? null;
          return { ...value, tracks, selectedTrackId };
        });
        return imported;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The media files could not be added.";
        if (
          mountedRef.current &&
          projectGenerationRef.current === projectGeneration &&
          importGenerationRef.current === importGeneration &&
          !optionsRef.current.isBlocked?.()
        )
          commit((value) => ({ ...value, importError: message }));
        throw error;
      } finally {
        if (importGenerationRef.current === importGeneration) {
          importRef.current = false;
          if (mountedRef.current) commit((value) => ({ ...value, importing: false }));
        }
      }
    },
    [commit],
  );

  const selectTrack = useCallback(
    (id: string | null) => {
      if (optionsRef.current.isBlocked?.()) return;
      commit((current) => ({
        ...current,
        selectedTrackId: id && current.tracks.some((track) => track.id === id) ? id : null,
      }));
    },
    [commit],
  );

  const activateTrack = useCallback(
    async (id: string) => {
      if (optionsRef.current.isBlocked?.()) return false;
      const track = stateRef.current.tracks.find((item) => item.id === id);
      if (!track) return false;
      const token = ++activationRef.current;
      pendingActivationRef.current = { token, id };
      commit((current) => ({ ...current, selectedTrackId: id }));
      try {
        const result = await optionsRef.current.activateTrack?.(track);
        if (
          result === false ||
          token !== activationRef.current ||
          !mountedRef.current ||
          optionsRef.current.isBlocked?.()
        )
          return false;
        const latest = stateRef.current.tracks.find((item) => item.id === id);
        if (!latest || latest.file !== track.file) return false;
        commit((current) => ({ ...current, activeTrackId: id }));
        if (pendingActivationRef.current?.token === token) pendingActivationRef.current = null;
        return true;
      } catch (error) {
        if (token === activationRef.current && mountedRef.current) {
          const message =
            error instanceof Error ? error.message : "The track could not be activated.";
          commit((current) => ({ ...current, importError: message }));
        }
        return false;
      } finally {
        if (pendingActivationRef.current?.token === token) pendingActivationRef.current = null;
      }
    },
    [commit],
  );

  const updateTrack = useCallback(
    (id: string, patch: ProjectTrackPatch) => {
      if (optionsRef.current.isBlocked?.()) return;
      const currentTrack = stateRef.current.tracks.find((track) => track.id === id);
      if (!currentTrack) return;
      const updatedTrack = updateProjectTrack(currentTrack, patch);
      commit((current) => ({
        ...current,
        tracks: current.tracks.map((track) => (track.id === id ? updatedTrack : track)),
      }));
    },
    [commit],
  );

  const reorderTrack = useCallback(
    (id: string, toIndex: number) => {
      if (optionsRef.current.isBlocked?.()) return;
      commit((current) => {
        const fromIndex = current.tracks.findIndex((track) => track.id === id);
        if (fromIndex < 0 || !Number.isFinite(toIndex)) return current;
        const destination = Math.max(0, Math.min(current.tracks.length - 1, Math.trunc(toIndex)));
        if (destination === fromIndex) return current;
        const tracks = [...current.tracks];
        const [track] = tracks.splice(fromIndex, 1);
        tracks.splice(destination, 0, track);
        return { ...current, tracks };
      });
    },
    [commit],
  );

  const moveTrack = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = stateRef.current.tracks.findIndex((track) => track.id === id);
      if (index >= 0) reorderTrack(id, index + direction);
    },
    [reorderTrack],
  );

  const removeTrack = useCallback(
    (id: string) => {
      if (optionsRef.current.isBlocked?.()) return;
      const removed = stateRef.current.tracks.find((track) => track.id === id);
      if (!removed) return;
      invalidateActivation(id);
      commit((current) => {
        const tracks = current.tracks.filter((track) => track.id !== id);
        const nextId = tracks[0]?.id ?? null;
        return {
          ...current,
          tracks,
          activeTrackId: current.activeTrackId === id ? null : current.activeTrackId,
          selectedTrackId: current.selectedTrackId === id ? nextId : current.selectedTrackId,
        };
      });
    },
    [commit, invalidateActivation],
  );

  const replaceTracks = useCallback(
    (tracks: ProjectTrack[], activeTrackId?: string | null) => {
      if (optionsRef.current.isBlocked?.() || tracks.length > PROJECT_LIMITS.tracks) return false;
      const validated = tracks.map((track) => updateProjectTrack(track, {}));
      const ids = new Set(validated.map((track) => track.id));
      if (ids.size !== validated.length) throw new Error("A project contains duplicate track IDs.");
      const nextActive = activeTrackId === undefined ? (validated[0]?.id ?? null) : activeTrackId;
      if (nextActive && !ids.has(nextActive))
        throw new Error("The selected track is missing from this project.");
      invalidateActivation();
      projectGenerationRef.current += 1;
      importGenerationRef.current += 1;
      importRef.current = false;
      commit((current) => ({
        ...current,
        tracks: validated,
        activeTrackId: nextActive,
        selectedTrackId: nextActive,
        importing: false,
        importError: "",
      }));
      return true;
    },
    [commit, invalidateActivation],
  );

  const upsertActiveTrack = useCallback(
    (track: ProjectTrack, activate = true) => {
      if (optionsRef.current.isBlocked?.()) return false;
      const validated = updateProjectTrack(track, {});
      const existing = stateRef.current.tracks.findIndex((item) => item.id === validated.id);
      if (existing < 0 && stateRef.current.tracks.length >= PROJECT_LIMITS.tracks)
        throw new Error("A project can contain up to 20 tracks.");
      if (existing >= 0 && stateRef.current.tracks[existing].file !== validated.file)
        invalidateActivation(validated.id);
      commit((current) => {
        const tracks = [...current.tracks];
        if (existing < 0) tracks.push(validated);
        else tracks[existing] = validated;
        return {
          ...current,
          tracks,
          activeTrackId: activate ? validated.id : current.activeTrackId,
          selectedTrackId: activate ? validated.id : current.selectedTrackId,
        };
      });
      return true;
    },
    [commit, invalidateActivation],
  );

  return {
    ...state,
    canAddFiles: state.tracks.length < PROJECT_LIMITS.tracks && !state.importing,
    addFiles,
    selectTrack,
    activateTrack,
    updateTrack,
    reorderTrack,
    moveTrack,
    removeTrack,
    replaceTracks,
    upsertActiveTrack,
  };
}
