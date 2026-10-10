import type { ExportSource } from "./export-job";
import type { ExportExtension } from "./export-destination";

export type ExportRequestKind = "video" | "still";

/** One output file in a batch. The source is a settings/media snapshot, not a decoded session. */
export type ExportRequest = {
  id: string;
  label: string;
  /** Filename stem; the selected encoder extension is added at delivery time. */
  filename: string;
  kind: ExportRequestKind;
  source: ExportSource;
  stillTime?: number;
};

export type ExportItemStatus =
  "pending" | "running" | "awaiting-download" | "complete" | "failed" | "stopped";

export type ExportRunItem = Pick<ExportRequest, "id" | "label" | "filename" | "kind"> & {
  status: ExportItemStatus;
  error?: string;
};

export type ExportRunState = {
  items: ExportRunItem[];
  currentId: string | null;
  paused: boolean;
};

export type ExportRequestOptions = Pick<ExportRequest, "label" | "filename" | "kind"> & {
  id?: string;
  stillTime?: number;
};

let fallbackRequestId = 0;

function requestId() {
  const id = globalThis.crypto?.randomUUID?.();
  if (id) return id;
  fallbackRequestId += 1;
  return `export-${Date.now().toString(36)}-${fallbackRequestId.toString(36)}`;
}

/** Clone editable values while retaining original file and image resource references. */
export function snapshotExportSource(
  source: ExportSource,
  options: { keepRuntime?: boolean } = {},
) {
  const keepRuntime = options.keepRuntime ?? true;
  return {
    ...source,
    range: [source.range[0], source.range[1]] as [number, number],
    settings: structuredClone(source.settings),
    subtitles: source.subtitles.map((cue) => ({ ...cue })),
    tracks: source.tracks?.map((track) => ({
      ...track,
      range: [track.range[0], track.range[1]] as [number, number],
      subtitles: track.subtitles.map((cue) => ({ ...cue })),
      // File objects and decoded image handles are intentionally retained by reference.
      artwork: track.artwork,
    })),
    // File refs are stable local inputs for a later queue item; decoded image handles
    // belong to the live media session and are not pinned by batch snapshots.
    logo: keepRuntime ? source.logo : null,
    background: keepRuntime ? source.background : null,
    artwork: keepRuntime ? source.artwork : null,
    // A batch prepares one segment at a time; it must not pin the active session's
    // full PCM, WASM feature cache, live graph, or media element for every request.
    prepared: keepRuntime ? source.prepared : undefined,
    snapshot: keepRuntime ? source.snapshot : undefined,
  } satisfies ExportSource;
}

export function createExportRequest(
  source: ExportSource,
  options: ExportRequestOptions,
): ExportRequest {
  if (!options.label.trim()) throw new Error("An export request needs a label.");
  if (!options.filename.trim()) throw new Error("An export request needs a filename.");
  if (options.kind === "still" && (!Number.isFinite(options.stillTime) || options.stillTime! < 0))
    throw new Error("Choose a valid thumbnail time.");
  return {
    id: options.id ?? requestId(),
    label: options.label.trim(),
    filename: safeFilenameStem(options.filename),
    kind: options.kind,
    source: snapshotExportSource(source),
    ...(options.kind === "still" ? { stillTime: options.stillTime } : {}),
  };
}

/** Snapshot a queue before any asynchronous media preparation starts. */
export function snapshotExportRequests(
  requests: readonly ExportRequest[],
  options: { keepRuntime?: boolean } = {},
): ExportRequest[] {
  if (!requests.length) throw new Error("Add at least one export request.");
  const ids = new Set<string>();
  return requests.map((request) => {
    if (!request.id || ids.has(request.id)) throw new Error("Export request IDs must be unique.");
    ids.add(request.id);
    if (!request.label.trim() || !request.filename.trim())
      throw new Error("Every export request needs a label and filename.");
    if (request.kind === "still" && (!Number.isFinite(request.stillTime) || request.stillTime! < 0))
      throw new Error("Choose a valid thumbnail time.");
    return {
      ...request,
      label: request.label.trim(),
      filename: safeFilenameStem(request.filename),
      source: snapshotExportSource(request.source, { keepRuntime: options.keepRuntime ?? false }),
    };
  });
}

export function safeFilenameStem(value: string) {
  const sanitized = [...value.trim()]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === "/" || character === "\\" || code < 32 || code === 127 ? "-" : character;
    })
    .join("");
  const normalized = sanitized.replace(/\.[a-z\d]{1,5}$/i, "").replace(/\s+/g, " ");
  if (!normalized || normalized === "." || normalized === "..")
    throw new Error("Choose a valid export filename.");
  return normalized.slice(0, 160);
}

/** Detect the final filename collisions before a folder/file picker is opened. */
export function validateUniqueExportFilenames(
  requests: readonly ExportRequest[],
  videoExtensions: ReadonlyMap<string, ExportExtension>,
) {
  const names = new Set<string>();
  for (const request of requests) {
    const extension = request.kind === "still" ? "png" : videoExtensions.get(request.id);
    if (!extension)
      throw new Error(`Check export support for “${request.label}” before saving the batch.`);
    const filename = `${safeFilenameStem(request.filename)}.${extension}`.toLocaleLowerCase(
      "en-US",
    );
    if (names.has(filename))
      throw new Error(
        `More than one request uses “${filename}”. Rename the outputs before exporting.`,
      );
    names.add(filename);
  }
}
