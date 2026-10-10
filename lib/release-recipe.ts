import type { ExportAspect, ExportResolution } from "./export-settings";
import type { ExportFrameRate } from "./export-timeline";
import type { ExportSource } from "./export-job";
import { createExportRequest, safeFilenameStem, type ExportRequest } from "./export-request";

export type ReleaseVideoOutput = {
  enabled: boolean;
  aspect: ExportAspect;
  resolution: ExportResolution;
  frameRate: ExportFrameRate;
  videoCompression: boolean;
  range: [number, number];
};

export type ReleaseStillOutput = {
  enabled: boolean;
  aspect: ExportAspect;
  resolution: ExportResolution;
  time: number;
};

export type ReleaseRecipe = {
  fullVideo: ReleaseVideoOutput;
  portraitTeaser: ReleaseVideoOutput;
  thumbnail: ReleaseStillOutput;
};

/** Translate a release recipe between active-track time and project-global time. */
export function shiftReleaseRecipe(recipe: ReleaseRecipe, offset: number): ReleaseRecipe {
  if (!Number.isFinite(offset)) throw new Error("The release time offset must be finite.");
  return {
    fullVideo: {
      ...recipe.fullVideo,
      range: [recipe.fullVideo.range[0] + offset, recipe.fullVideo.range[1] + offset],
    },
    portraitTeaser: {
      ...recipe.portraitTeaser,
      range: [recipe.portraitTeaser.range[0] + offset, recipe.portraitTeaser.range[1] + offset],
    },
    thumbnail: { ...recipe.thumbnail, time: recipe.thumbnail.time + offset },
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function sourceStem(source: ExportSource) {
  const file = source.tracks?.[0]?.file ?? source.file;
  return safeFilenameStem(file.name.replace(/\.[^.]+$/, ""));
}

export function createDefaultReleaseRecipe(
  source: ExportSource,
  selectedTime?: number,
): ReleaseRecipe {
  const [start, end] = source.range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("Choose a valid time range before creating a release package.");
  const teaserEnd = Math.min(end, start + 30);
  return {
    fullVideo: {
      enabled: true,
      aspect: source.format,
      resolution: source.resolution,
      frameRate: source.frameRate,
      videoCompression: source.videoCompression,
      range: [start, end],
    },
    portraitTeaser: {
      enabled: true,
      aspect: "portrait",
      resolution: source.resolution,
      frameRate: source.frameRate,
      videoCompression: source.videoCompression,
      range: [start, teaserEnd],
    },
    thumbnail: {
      enabled: true,
      aspect: source.format,
      resolution: source.resolution,
      time: clamp(selectedTime ?? (start + teaserEnd) / 2, start, end),
    },
  };
}

function validVideoOutput(output: ReleaseVideoOutput, source: ExportSource, name: string) {
  const [min, max] = source.range;
  if (
    !Number.isFinite(output.range[0]) ||
    !Number.isFinite(output.range[1]) ||
    output.range[0] < min ||
    output.range[1] > max ||
    output.range[1] - output.range[0] < 0.1
  ) {
    throw new Error(`${name} needs a time range of at least 0.1 seconds within the project.`);
  }
}

/** Build independent file requests from a shared project snapshot. */
export function makeReleaseRequests(source: ExportSource, recipe: ReleaseRecipe): ExportRequest[] {
  const requests: ExportRequest[] = [];
  const stem = sourceStem(source);
  if (recipe.fullVideo.enabled) {
    validVideoOutput(recipe.fullVideo, source, "Full video");
    requests.push(
      createExportRequest(
        {
          ...source,
          format: recipe.fullVideo.aspect,
          resolution: recipe.fullVideo.resolution,
          frameRate: recipe.fullVideo.frameRate,
          videoCompression: recipe.fullVideo.videoCompression,
          range: [...recipe.fullVideo.range],
        },
        { id: "release-full-video", kind: "video", label: "Full video", filename: `${stem}-full` },
      ),
    );
  }
  if (recipe.portraitTeaser.enabled) {
    validVideoOutput(recipe.portraitTeaser, source, "Portrait teaser");
    if (recipe.portraitTeaser.aspect !== "portrait")
      throw new Error("The teaser output must use portrait orientation.");
    requests.push(
      createExportRequest(
        {
          ...source,
          format: "portrait",
          resolution: recipe.portraitTeaser.resolution,
          frameRate: recipe.portraitTeaser.frameRate,
          videoCompression: recipe.portraitTeaser.videoCompression,
          range: [...recipe.portraitTeaser.range],
        },
        {
          id: "release-portrait-teaser",
          kind: "video",
          label: "Portrait teaser",
          filename: `${stem}-teaser-portrait`,
        },
      ),
    );
  }
  if (recipe.thumbnail.enabled) {
    const [min, max] = source.range;
    if (
      !Number.isFinite(recipe.thumbnail.time) ||
      recipe.thumbnail.time < min ||
      recipe.thumbnail.time > max
    )
      throw new Error("Choose a thumbnail time inside the project range.");
    requests.push(
      createExportRequest(
        {
          ...source,
          format: recipe.thumbnail.aspect,
          resolution: recipe.thumbnail.resolution,
        },
        {
          id: "release-thumbnail",
          kind: "still",
          label: "Selected-time PNG",
          filename: `${stem}-thumbnail`,
          stillTime: recipe.thumbnail.time,
        },
      ),
    );
  }
  if (!requests.length) throw new Error("Select at least one release output.");
  return requests;
}
