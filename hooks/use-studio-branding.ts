import { useCallback } from "react";
import {
  applyArtistProfileStyle,
  type ArtistProfileApplication,
  type ArtistProfileAssets,
} from "@/lib/artist-profile";
import type { VisualSettings } from "@/lib/visual-settings-model";
import type { UseMediaSessionResult } from "./use-media-session";
import type { ProjectTrack } from "@/lib/project-model";
import type { UseProjectTracksResult } from "./use-project-tracks";

export function useStudioBranding({
  media,
  tracks,
  activeTrack,
  commitSettings,
  isBlocked,
}: {
  media: UseMediaSessionResult;
  tracks: UseProjectTracksResult;
  activeTrack: ProjectTrack | null;
  commitSettings: (update: (current: VisualSettings) => VisualSettings) => void;
  isBlocked: () => boolean;
}) {
  const assets: ArtistProfileAssets = {};
  for (const kind of ["logo", "background", "artwork"] as const) {
    const file = media.snapshot[kind]?.file;
    if (file) assets[kind] = { blob: file, name: file.name, type: file.type, size: file.size };
  }
  const apply = useCallback(
    async (profile: ArtistProfileApplication) => {
      if (isBlocked()) throw new Error("Branding is locked during export.");
      const generation = media.session.requestGeneration;
      const sourceFile = media.session.snapshot.file;
      const changes: Partial<Record<"logo" | "background" | "artwork", File>> = {};
      for (const kind of ["logo", "background", "artwork"] as const) {
        const asset = profile.assets[kind];
        if (asset) changes[kind] = new File([asset.blob], asset.name, { type: asset.type });
      }
      if (Object.keys(changes).length && !(await media.replaceAssets(changes)))
        throw new Error(
          "The profile images could not be applied. Your existing branding was kept.",
        );
      if (isBlocked()) throw new Error("Branding is locked during export.");
      if (
        generation !== media.session.requestGeneration ||
        sourceFile !== media.session.snapshot.file
      )
        throw new Error(
          "The project changed while applying branding. Please apply the profile again.",
        );
      commitSettings((current) => applyArtistProfileStyle(current, profile.style));
      if (activeTrack)
        tracks.updateTrack(activeTrack.id, {
          ...(changes.artwork ? { artwork: changes.artwork } : {}),
          ...(profile.applyDefaultArtist ? { artist: profile.defaultArtist } : {}),
        });
    },
    [activeTrack, commitSettings, isBlocked, media, tracks],
  );
  return { assets, apply };
}
