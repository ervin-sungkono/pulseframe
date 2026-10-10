import type { StreamTargetChunk } from "mediabunny";

export type ExportExtension = "mp4" | "webm" | "png";
export type ExportWritableHandle = {
  createWritable: (options?: { keepExistingData?: boolean }) => Promise<ExportPhysicalWritable>;
};

export type ExportPhysicalWritable = {
  write: (chunk: { type: "write"; data: Uint8Array; position: number }) => Promise<void>;
  close: () => Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
};

export type ExportDestinationWriter = {
  /** Mediabunny writes positioned chunks here; closing this stream never commits the file. */
  stream: WritableStream<StreamTargetChunk>;
  commit: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
};

export type ExportDestination = {
  createWriter: (extension: ExportExtension, filename: string) => Promise<ExportDestinationWriter>;
};

export type ExportFileHandle = ExportWritableHandle;

type SavePickerOptions = {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type DirectoryFileHandle = ExportWritableHandle & {
  getFile: () => Promise<File>;
  isSameEntry: (other: DirectoryFileHandle) => Promise<boolean>;
};
type ExportDirectoryHandle = {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<DirectoryFileHandle>;
  removeEntry: (name: string) => Promise<void>;
};

type ExportWindow = Window & {
  showSaveFilePicker?: (options?: SavePickerOptions) => Promise<ExportWritableHandle>;
  showDirectoryPicker?: () => Promise<ExportDirectoryHandle>;
};

function safeFilename(filename: string, extension: ExportExtension) {
  const name = filename.trim();
  const hasControlCharacter = Array.from(name).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || hasControlCharacter)
    throw new Error("Choose a valid export filename.");
  const suffix = `.${extension}`;
  return name.toLowerCase().endsWith(suffix) ? name : `${name}${suffix}`;
}

function abortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Adapts a File System Access writable to Mediabunny's positioned stream.
 * Mediabunny closes this stream both after finalization and while canceling, so
 * the wrapper deliberately keeps physical close under the export transaction.
 */
function writerFor(
  handle: ExportWritableHandle,
  onAbort?: () => Promise<void>,
): Promise<ExportDestinationWriter> {
  return handle
    .createWritable({ keepExistingData: false })
    .then((physical) => {
      let settled = false;
      let committed = false;
      let physicalAborted = false;
      const abortTransaction = async (reason?: unknown) => {
        if (settled || committed) return;
        if (!physicalAborted) {
          await abortPhysical(physical, reason);
          physicalAborted = true;
        }
        await onAbort?.();
        settled = true;
      };
      const stream = new WritableStream<StreamTargetChunk>({
        write: async (chunk) => {
          if (settled) throw new Error("The export destination is already closed.");
          try {
            await physical.write({ type: "write", data: chunk.data, position: chunk.position });
          } catch (error) {
            throw new Error(
              "The export file could not be written. Check available disk space and permissions.",
              {
                cause: error,
              },
            );
          }
        },
        // StreamTarget closes its own stream on both finalize() and cancel().
        close: () => {},
        abort: abortTransaction,
      });

      return {
        stream,
        commit: async () => {
          if (settled) throw new Error("The export destination has already been settled.");
          try {
            await physical.close();
            committed = true;
            settled = true;
          } catch (error) {
            await abortTransaction(error).catch(() => {});
            throw new Error(
              "The export file could not be finalized. Check available disk space and permissions.",
              {
                cause: error,
              },
            );
          }
        },
        abort: abortTransaction,
      };
    })
    .catch(async (error) => {
      await onAbort?.().catch(() => {});
      throw error;
    });
}

async function removeUnchangedDirectoryEntry(
  directory: ExportDirectoryHandle,
  name: string,
  handle: DirectoryFileHandle,
  initialFile: File,
) {
  let current: DirectoryFileHandle;
  try {
    current = await directory.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  if (!(await current.isSameEntry(handle))) return;
  const currentFile = await current.getFile();
  if (
    currentFile.size !== initialFile.size ||
    currentFile.lastModified !== initialFile.lastModified
  )
    return;
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

async function abortPhysical(physical: ExportPhysicalWritable, reason?: unknown) {
  if (physical.abort) {
    await physical.abort(reason);
    return;
  }
  // File System WritableFileStream implementations provide abort(); this path
  // is only for nonstandard shims and should never commit an incomplete file.
  throw new Error("This browser cannot safely discard an incomplete export.", { cause: reason });
}

export function createExportDestination(handle: ExportWritableHandle): ExportDestination {
  return {
    createWriter: async () => writerFor(handle),
  };
}

export function supportsFileExport() {
  try {
    return (
      typeof window !== "undefined" &&
      typeof (window as ExportWindow).showSaveFilePicker === "function"
    );
  } catch {
    return false;
  }
}

export function supportsDirectoryExport() {
  try {
    return (
      typeof window !== "undefined" &&
      typeof (window as ExportWindow).showDirectoryPicker === "function"
    );
  } catch {
    return false;
  }
}

/** Call from the user's click handler before awaiting export preparation. */
export async function pickExportDestination(
  extension: ExportExtension,
  filename: string,
): Promise<ExportDestination | null> {
  if (!supportsFileExport()) return null;
  const showPicker = (window as ExportWindow).showSaveFilePicker!;
  try {
    const handle = await showPicker({
      suggestedName: safeFilename(filename, extension),
      types: [
        {
          description:
            extension === "png" ? "PNG image" : extension === "mp4" ? "MP4 video" : "WebM video",
          accept: {
            [extension === "png" ? "image/png" : extension === "mp4" ? "video/mp4" : "video/webm"]:
              [`.${extension}`],
          },
        },
      ],
    });
    return createExportDestination(handle);
  } catch (error) {
    if (abortError(error)) return null;
    throw new Error(
      "The export file could not be selected. Check browser permissions and try again.",
      {
        cause: error,
      },
    );
  }
}

/**
 * Picks one directory for a batch. Each call to createWriter creates a fresh,
 * collision-safe file within that directory.
 */
export async function pickExportDirectoryDestination(): Promise<ExportDestination | null> {
  if (!supportsDirectoryExport()) return null;
  try {
    const directory = await (window as ExportWindow).showDirectoryPicker!();
    return {
      createWriter: async (extension, filename) => {
        const name = safeFilename(filename, extension);
        let existing: DirectoryFileHandle | null = null;
        try {
          existing = await directory.getFileHandle(name);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
        }
        if (existing)
          throw new Error(`A file named “${name}” already exists in the selected folder.`);
        const handle = await directory.getFileHandle(name, { create: true });
        const initialFile = await handle.getFile();
        return writerFor(handle, () =>
          removeUnchangedDirectoryEntry(directory, name, handle, initialFile),
        );
      },
    };
  } catch (error) {
    if (abortError(error)) return null;
    throw new Error(
      "The export folder could not be selected. Check browser permissions and try again.",
      {
        cause: error,
      },
    );
  }
}
