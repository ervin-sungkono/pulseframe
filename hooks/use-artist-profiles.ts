import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtistProfile, ArtistProfileDraft, ArtistProfileSummary } from "@/lib/artist-profile";
import {
  ArtistProfileStore,
  ArtistProfileStoreError,
  createArtistProfileId,
  listenForArtistProfileChanges,
} from "@/lib/artist-profile-store";
import { makeArtistProfileFile, readArtistProfileFile } from "@/lib/artist-profile-file";

const store = new ArtistProfileStore();

export type ArtistProfileLibrary = {
  profiles: ArtistProfileSummary[];
  loading: boolean;
  error: string;
  search: string;
  setSearch: (value: string) => void;
  refresh: () => Promise<void>;
  get: (id: string) => Promise<ArtistProfile | null>;
  create: (draft: ArtistProfileDraft, stableId?: string) => Promise<ArtistProfile>;
  update: (
    id: string,
    expectedRevision: number,
    draft: ArtistProfileDraft,
  ) => Promise<ArtistProfile>;
  remove: (profile: ArtistProfileSummary) => Promise<void>;
  importFile: (file: Blob) => Promise<ArtistProfile>;
  exportFile: (id: string) => Promise<Blob>;
};

/** Controller for browser-local profiles; UI state changes only after IndexedDB commits. */
export function useArtistProfiles(): ArtistProfileLibrary {
  const [allProfiles, setAllProfiles] = useState<ArtistProfileSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearchState] = useState("");

  const refresh = useCallback(async () => {
    try {
      setAllProfiles(await store.list());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load artist profiles.");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = listenForArtistProfileChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const runMutation = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        await refresh();
        return result;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save the artist profile.");
        throw caught;
      }
    },
    [refresh],
  );

  const matching = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query
      ? allProfiles.filter(
          (profile) =>
            profile.name.toLocaleLowerCase().includes(query) ||
            profile.defaultArtist.toLocaleLowerCase().includes(query),
        )
      : allProfiles;
  }, [allProfiles, search]);

  return {
    profiles: matching,
    loading: !ready,
    error,
    search,
    setSearch: setSearchState,
    refresh,
    get: (id) => store.get(id),
    create: (draft, stableId = createArtistProfileId()) =>
      runMutation(() => store.create(stableId, draft)),
    update: (id, expectedRevision, draft) =>
      runMutation(() => store.update(id, expectedRevision, draft)),
    remove: (profile) => runMutation(() => store.remove(profile.id, profile.revision)),
    importFile: async (file) => {
      try {
        const draft = await readArtistProfileFile(file);
        return await runMutation(() => store.create(createArtistProfileId(), draft));
      } catch (caught) {
        if (caught instanceof ArtistProfileStoreError) setError(caught.message);
        else setError(caught instanceof Error ? caught.message : "Could not import this profile.");
        throw caught;
      }
    },
    exportFile: async (id) => {
      const profile = await store.get(id);
      if (!profile)
        throw new ArtistProfileStoreError("This artist profile no longer exists.", "missing");
      return makeArtistProfileFile({
        name: profile.name,
        defaultArtist: profile.defaultArtist,
        style: profile.style,
        assets: profile.assets,
      });
    },
  };
}
