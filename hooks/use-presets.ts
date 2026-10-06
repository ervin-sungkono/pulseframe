"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PresetStyle, SavedPreset } from "@/lib/presets";

type PresetPage = { presets?: SavedPreset[]; cursor?: string | null };
type PresetApiData = PresetPage & { error?: string; signin?: string; preset?: SavedPreset };

export type CreatePresetInput = {
  id: string;
  name: string;
  settings: PresetStyle;
  pinned?: boolean;
  quickLookOrder?: number;
};

export type UpdatePresetInput = {
  name?: string;
  settings?: PresetStyle;
  pinned?: boolean;
  quickLookOrder?: number;
  expectedRevision: number;
};

export class PresetRequestError extends Error {
  readonly status: number;
  readonly signin: string | null;
  readonly preset: SavedPreset | null;

  constructor(message: string, status: number, signin: string | null = null, preset: SavedPreset | null = null) {
    super(message);
    this.name = "PresetRequestError";
    this.status = status;
    this.signin = signin;
    this.preset = preset;
  }
}

export type PresetLibrary = {
  presets: SavedPreset[];
  pinnedPresets: SavedPreset[];
  loading: boolean;
  pinnedLoading: boolean;
  ready: boolean;
  pinnedReady: boolean;
  error: string;
  signin: string | null;
  search: string;
  setSearch: (value: string) => void;
  cursor: string | null;
  pinnedCursor: string | null;
  load: (cursor?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshPinned: () => Promise<void>;
  loadMorePinned: () => Promise<void>;
  create: (input: CreatePresetInput) => Promise<SavedPreset>;
  update: (id: string, input: UpdatePresetInput) => Promise<SavedPreset>;
  reorder: (first: SavedPreset, second: SavedPreset) => Promise<[SavedPreset, SavedPreset]>;
  remove: (id: string) => Promise<void>;
};

function messageFor(caught: unknown, fallback: string) {
  if (caught instanceof TypeError) return "Check your connection and try again.";
  return caught instanceof Error ? caught.message : fallback;
}

async function readApiData(response: Response): Promise<PresetApiData> {
  try {
    return await response.json() as PresetApiData;
  } catch {
    throw new Error("Could not connect to your preset library. Please try again.");
  }
}

function sortedByUpdatedAt(presets: SavedPreset[]) {
  return [...presets].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

function sortedByQuickLookOrder(presets: SavedPreset[]) {
  return [...presets].sort((a, b) => a.quickLookOrder - b.quickLookOrder || a.id.localeCompare(b.id));
}

function upsertUnique(presets: SavedPreset[], preset: SavedPreset, sort: (items: SavedPreset[]) => SavedPreset[]) {
  return sort([preset, ...presets.filter(item => item.id !== preset.id)]);
}

function nextQuickLookOrder(presets: SavedPreset[]) {
  const lastKnownOrder = presets.reduce((maximum, preset) => Math.max(maximum, preset.quickLookOrder), -1);
  return Math.max(Date.now(), lastKnownOrder + 1);
}

export function usePresets(): PresetLibrary {
  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [pinnedPresets, setPinnedPresets] = useState<SavedPreset[]>([]);
  const [search, setSearchState] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [pinnedCursor, setPinnedCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [pinnedReady, setPinnedReady] = useState(false);
  const [error, setError] = useState("");
  const [signin, setSignin] = useState<string | null>(null);

  const readyRef = useRef(ready);
  const pinnedReadyRef = useRef(pinnedReady);
  const presetsRef = useRef(presets);
  const pinnedPresetsRef = useRef(pinnedPresets);
  const searchRef = useRef(search);
  const cursorRef = useRef<string | null>(null);
  const pinnedCursorRef = useRef<string | null>(null);
  const mainControllerRef = useRef<AbortController | null>(null);
  const pinnedControllerRef = useRef<AbortController | null>(null);
  const mainGenerationRef = useRef(0);
  const pinnedGenerationRef = useRef(0);
  const mainRequestsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  const pinnedRequestsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());

  useEffect(() => {
    readyRef.current = ready;
    pinnedReadyRef.current = pinnedReady;
    presetsRef.current = presets;
    pinnedPresetsRef.current = pinnedPresets;
  }, [pinnedPresets, pinnedReady, presets, ready]);

  const setSearch = useCallback((value: string) => {
    if (value === searchRef.current) return;
    searchRef.current = value;
    mainControllerRef.current?.abort();
    mainGenerationRef.current += 1;
    mainRequestsRef.current.clear();
    cursorRef.current = null;
    setLoading(false);
    setError("");
    setPresets([]);
    setCursor(null);
    readyRef.current = false;
    setReady(false);
    setSearchState(value);
  }, []);

  const markSignedOut = useCallback((url: string | null) => {
    setSignin(url);
    setPresets([]);
    setPinnedPresets([]);
    setCursor(null);
    cursorRef.current = null;
    setPinnedCursor(null);
    pinnedCursorRef.current = null;
    setReady(true);
    setPinnedReady(true);
  }, []);

  const load = useCallback((next?: string): Promise<void> => {
    const query = searchRef.current.trim();
    const requestKey = `${query}\u0000${next ?? ""}`;
    const existing = mainRequestsRef.current.get(requestKey);
    if (existing && !existing.controller.signal.aborted) return existing.promise;
    if (existing) mainRequestsRef.current.delete(requestKey);

    mainControllerRef.current?.abort();
    const controller = new AbortController();
    mainControllerRef.current = controller;
    const generation = ++mainGenerationRef.current;
    setLoading(true);
    setError("");

    const entry: { controller: AbortController; promise: Promise<void> } = { controller, promise: Promise.resolve() };
    const request = (async () => {
      try {
        const params = new URLSearchParams({ q: query });
        if (next) params.set("cursor", next);
        const response = await fetch(`/api/presets?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await readApiData(response);
        if (controller.signal.aborted || generation !== mainGenerationRef.current) return;
        if (response.status === 401) {
          markSignedOut(data.signin ?? null);
          return;
        }
        if (!response.ok) throw new PresetRequestError(data.error ?? "Could not load your presets.", response.status, data.signin ?? null, data.preset ?? null);

        setSignin(null);
        setError("");
        const items = data.presets ?? [];
        if (next) {
          setPresets(previous => {
            const seen = new Set(previous.map(item => item.id));
            return [...previous, ...items.filter(item => !seen.has(item.id))];
          });
        } else {
          setPresets(items);
        }
        setCursor(data.cursor ?? null);
        cursorRef.current = data.cursor ?? null;
        setReady(true);
      } catch (caught) {
        if (!controller.signal.aborted && generation === mainGenerationRef.current) {
          setError(messageFor(caught, "Could not load your presets."));
          setReady(true);
        }
      } finally {
        if (mainRequestsRef.current.get(requestKey) === entry) mainRequestsRef.current.delete(requestKey);
        if (!controller.signal.aborted && generation === mainGenerationRef.current) setLoading(false);
      }
    })();
    entry.promise = request;
    mainRequestsRef.current.set(requestKey, entry);
    return request;
  }, [markSignedOut]);

  const loadPinned = useCallback((next?: string): Promise<void> => {
    const requestKey = next ?? "first-page";
    const existing = pinnedRequestsRef.current.get(requestKey);
    if (existing && !existing.controller.signal.aborted) return existing.promise;
    if (existing) pinnedRequestsRef.current.delete(requestKey);

    pinnedControllerRef.current?.abort();
    const controller = new AbortController();
    pinnedControllerRef.current = controller;
    const generation = ++pinnedGenerationRef.current;
    setPinnedLoading(true);
    setError("");

    const entry: { controller: AbortController; promise: Promise<void> } = { controller, promise: Promise.resolve() };
    const request = (async () => {
      try {
        const params = new URLSearchParams({ pinned: "1" });
        if (next) params.set("cursor", next);
        const response = await fetch(`/api/presets?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await readApiData(response);
        if (controller.signal.aborted || generation !== pinnedGenerationRef.current) return;
        if (response.status === 401) {
          markSignedOut(data.signin ?? null);
          return;
        }
        if (!response.ok) throw new PresetRequestError(data.error ?? "Could not load your Quick Looks.", response.status, data.signin ?? null, data.preset ?? null);

        setSignin(null);
        setError("");
        const items = (data.presets ?? []).filter(item => item.pinned);
        if (next) {
          setPinnedPresets(previous => {
            const seen = new Set(previous.map(item => item.id));
            return sortedByQuickLookOrder([...previous, ...items.filter(item => !seen.has(item.id))]);
          });
        } else {
          setPinnedPresets(sortedByQuickLookOrder(items));
        }
        setPinnedCursor(data.cursor ?? null);
        pinnedCursorRef.current = data.cursor ?? null;
        setPinnedReady(true);
      } catch (caught) {
        if (!controller.signal.aborted && generation === pinnedGenerationRef.current) {
          setError(messageFor(caught, "Could not load your Quick Looks."));
          setPinnedReady(true);
        }
      } finally {
        if (pinnedRequestsRef.current.get(requestKey) === entry) pinnedRequestsRef.current.delete(requestKey);
        if (!controller.signal.aborted && generation === pinnedGenerationRef.current) setPinnedLoading(false);
      }
    })();
    entry.promise = request;
    pinnedRequestsRef.current.set(requestKey, entry);
    return request;
  }, [markSignedOut]);

  const refresh = useCallback(() => load(), [load]);
  const refreshPinned = useCallback(() => loadPinned(), [loadPinned]);
  const loadMore = useCallback(() => cursorRef.current ? load(cursorRef.current) : Promise.resolve(), [load]);
  const loadMorePinned = useCallback(() => pinnedCursorRef.current ? loadPinned(pinnedCursorRef.current) : Promise.resolve(), [loadPinned]);

  useEffect(() => {
    void refreshPinned();
    return () => {
      mainControllerRef.current?.abort();
      pinnedControllerRef.current?.abort();
    };
  }, [refreshPinned]);

  const invalidateReads = useCallback(() => {
    mainControllerRef.current?.abort();
    pinnedControllerRef.current?.abort();
    mainGenerationRef.current += 1;
    pinnedGenerationRef.current += 1;
    mainRequestsRef.current.clear();
    pinnedRequestsRef.current.clear();
    setLoading(false);
    setPinnedLoading(false);
  }, []);

  const reconcilePreset = useCallback((preset: SavedPreset) => {
    const query = searchRef.current.trim().toLocaleLowerCase();
    const matchesSearch = !query || preset.name.toLocaleLowerCase().includes(query);
    setPresets(previous => {
      const without = previous.filter(item => item.id !== preset.id);
      return matchesSearch && readyRef.current ? upsertUnique(without, preset, sortedByUpdatedAt) : without;
    });
    setPinnedPresets(previous => {
      const without = previous.filter(item => item.id !== preset.id);
      return preset.pinned && pinnedReadyRef.current ? upsertUnique(without, preset, sortedByQuickLookOrder) : without;
    });
  }, []);

  const mutationFailure = useCallback((caught: unknown, fallback: string): never => {
    if (caught instanceof PresetRequestError && caught.status === 401) markSignedOut(caught.signin);
    setError(messageFor(caught, fallback));
    throw caught instanceof Error ? caught : new Error(fallback);
  }, [markSignedOut]);

  const create = useCallback(async (input: CreatePresetInput): Promise<SavedPreset> => {
    try {
      const knownPresets = [...pinnedPresetsRef.current, ...presetsRef.current];
      const payload = {
        ...input,
        quickLookOrder: input.quickLookOrder ?? (input.pinned ? nextQuickLookOrder(knownPresets) : 0),
      };
      const response = await fetch("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(payload),
      });
      const data = await readApiData(response);
      if (response.status === 401) markSignedOut(data.signin ?? null);
      if (!response.ok) throw new PresetRequestError(data.error ?? "Could not save this preset.", response.status, data.signin ?? null);
      if (!data.preset) throw new Error("The preset could not be confirmed. Try again.");
      setSignin(null);
      setError("");
      invalidateReads();
      reconcilePreset(data.preset);
      const refreshes: Promise<void>[] = [];
      if (readyRef.current) refreshes.push(load());
      if (pinnedReadyRef.current) refreshes.push(loadPinned());
      void Promise.all(refreshes);
      return data.preset;
    } catch (caught) {
      return mutationFailure(caught, "Could not save this preset.");
    }
  }, [invalidateReads, load, loadPinned, markSignedOut, mutationFailure, reconcilePreset]);

  const update = useCallback(async (id: string, input: UpdatePresetInput): Promise<SavedPreset> => {
    try {
      const knownPresets = [...pinnedPresetsRef.current, ...presetsRef.current];
      const existing = knownPresets.find(preset => preset.id === id);
      const payload: UpdatePresetInput = {
        ...input,
        ...(input.pinned === true && input.quickLookOrder === undefined && !existing?.pinned
          ? { quickLookOrder: nextQuickLookOrder(knownPresets) }
          : {}),
      };
      const response = await fetch(`/api/presets/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(payload),
      });
      const data = await readApiData(response);
      if (response.status === 401) markSignedOut(data.signin ?? null);
      if (!response.ok) throw new PresetRequestError(data.error ?? "Could not update this preset.", response.status, data.signin ?? null, data.preset ?? null);
      if (!data.preset) throw new Error("The preset could not be confirmed. Try again.");
      setSignin(null);
      setError("");
      invalidateReads();
      reconcilePreset(data.preset);
      const refreshes: Promise<void>[] = [];
      if (readyRef.current) refreshes.push(load());
      if (pinnedReadyRef.current) refreshes.push(loadPinned());
      void Promise.all(refreshes);
      return data.preset;
    } catch (caught) {
      return mutationFailure(caught, "Could not update this preset.");
    }
  }, [invalidateReads, load, loadPinned, markSignedOut, mutationFailure, reconcilePreset]);

  const reorder = useCallback(async (first: SavedPreset, second: SavedPreset): Promise<[SavedPreset, SavedPreset]> => {
    try {
      const response = await fetch("/api/presets/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          first: { id: first.id, expectedRevision: first.revision },
          second: { id: second.id, expectedRevision: second.revision },
        }),
      });
      const data = await readApiData(response);
      if (response.status === 401) markSignedOut(data.signin ?? null);
      if (!response.ok) throw new PresetRequestError(data.error ?? "Could not reorder these Quick Looks.", response.status, data.signin ?? null, data.preset ?? null);
      if (!data.presets || data.presets.length !== 2) throw new Error("The Quick Look order could not be confirmed. Refresh and try again.");
      setSignin(null);
      setError("");
      invalidateReads();
      data.presets.forEach(reconcilePreset);
      const refreshes: Promise<void>[] = [];
      if (readyRef.current) refreshes.push(load());
      if (pinnedReadyRef.current) refreshes.push(loadPinned());
      void Promise.all(refreshes);
      return [data.presets[0], data.presets[1]];
    } catch (caught) {
      return mutationFailure(caught, "Could not reorder these Quick Looks.");
    }
  }, [invalidateReads, load, loadPinned, markSignedOut, mutationFailure, reconcilePreset]);

  const remove = useCallback(async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/api/presets/${encodeURIComponent(id)}`, { method: "DELETE", cache: "no-store" });
      const data = await readApiData(response);
      if (response.status === 401) markSignedOut(data.signin ?? null);
      if (!response.ok) throw new PresetRequestError(data.error ?? "Could not delete this preset.", response.status, data.signin ?? null);
      invalidateReads();
      setPresets(previous => previous.filter(item => item.id !== id));
      setPinnedPresets(previous => previous.filter(item => item.id !== id));
      setError("");
      const refreshes: Promise<void>[] = [];
      if (readyRef.current) refreshes.push(load());
      if (pinnedReadyRef.current) refreshes.push(loadPinned());
      void Promise.all(refreshes);
    } catch (caught) {
      mutationFailure(caught, "Could not delete this preset.");
    }
  }, [invalidateReads, load, loadPinned, markSignedOut, mutationFailure]);

  return {
    presets,
    pinnedPresets,
    loading,
    pinnedLoading,
    ready,
    pinnedReady,
    error,
    signin,
    search,
    setSearch,
    cursor,
    pinnedCursor,
    load,
    loadMore,
    refresh,
    refreshPinned,
    loadMorePinned,
    create,
    update,
    reorder,
    remove,
  };
}
