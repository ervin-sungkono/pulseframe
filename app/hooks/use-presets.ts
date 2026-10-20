import { useCallback, useEffect, useMemo, useState } from "react";
import type { SavedPreset } from "@/lib/visual/presets";
import {
  PRESET_STORAGE_KEY,
  PresetStore,
  type CreatePresetInput,
  type UpdatePresetInput,
} from "@/lib/persistence/preset-store";

const store = new PresetStore();
const PAGE_SIZE = 50;

export type PresetLibrary = {
  presets: SavedPreset[];
  pinnedPresets: SavedPreset[];
  loading: boolean;
  error: string;
  search: string;
  setSearch: (value: string) => void;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => Promise<void>;
  create: (input: CreatePresetInput) => Promise<SavedPreset>;
  update: (id: string, input: UpdatePresetInput) => Promise<SavedPreset>;
  reorder: (first: SavedPreset, second: SavedPreset) => Promise<[SavedPreset, SavedPreset]>;
  remove: (id: string) => Promise<void>;
};

/** Controller for the browser-local library; mutations publish only after storage succeeds. */
export function usePresets(): PresetLibrary {
  const [allPresets, setAllPresets] = useState<SavedPreset[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearchState] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const refresh = useCallback(async () => {
    try {
      setAllPresets(store.list());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your saved looks.");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key === PRESET_STORAGE_KEY || event.key === null) void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  const runMutation = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        await refresh();
        return result;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save your look.");
        throw caught;
      }
    },
    [refresh],
  );

  const matching = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query
      ? allPresets.filter((preset) => preset.name.toLocaleLowerCase().includes(query))
      : allPresets;
  }, [allPresets, search]);
  const pinnedPresets = useMemo(
    () =>
      allPresets
        .filter((preset) => preset.pinned)
        .sort((a, b) => a.quickLookOrder - b.quickLookOrder || a.id.localeCompare(b.id)),
    [allPresets],
  );

  return {
    presets: matching.slice(0, visibleCount),
    pinnedPresets,
    loading: !ready,
    error,
    search,
    setSearch: (value) => {
      setSearchState(value);
      setVisibleCount(PAGE_SIZE);
    },
    hasMore: matching.length > visibleCount,
    loadMore: () => setVisibleCount((count) => count + PAGE_SIZE),
    refresh,
    create: (input) => runMutation(() => store.create(input)),
    update: (id, input) => runMutation(() => store.update(id, input)),
    reorder: (first, second) => runMutation(() => store.reorder(first, second)),
    remove: (id) => runMutation(() => store.remove(id)),
  };
}
