import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/** The small part of FileSystemFileHandle needed by the export adapter. */
export type ExportDestination = Pick<FileSystemFileHandle, "createWritable">;

type ExportWritable = Pick<FileSystemWritableFileStream, "write" | "close" | "abort">;

export type ExportFileTarget = {
  target: StreamTarget;
  /** Commit only after Mediabunny has successfully finalized and the caller has checked abort. */
  commit: (onCommitStart?: () => void) => Promise<void>;
  /** Discard an uncommitted file transaction. Calling this after commit starts is ignored. */
  abort: (reason?: unknown) => Promise<void>;
  readonly commitStarted: boolean;
};

/**
 * Wrap Mediabunny's seekable stream target in a File System Access transaction.
 * Mediabunny closes its own stream on finalize/cancel; that close deliberately
 * does not close the file handle, because FileSystemWritableFileStream.close()
 * commits the destination and would otherwise leave partial files on failures.
 */
export async function createExportFileTarget(
  destination: ExportDestination,
): Promise<ExportFileTarget> {
  const writable: ExportWritable = await destination.createWritable();
  let commitStarted = false;
  let committed = false;
  let aborted = false;

  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>(
      {
        write: (chunk) => writable.write(chunk),
        // The transaction is committed explicitly only after output.finalize().
        close: () => {},
      },
      { highWaterMark: 1 },
    ),
  );

  return {
    target,
    get commitStarted() {
      return commitStarted;
    },
    async commit(onCommitStart) {
      if (aborted) throw new Error("The export file transaction was aborted.");
      if (committed) return;
      if (commitStarted) throw new Error("The export file transaction is already committing.");
      commitStarted = true;
      onCommitStart?.();
      try {
        await writable.close();
        committed = true;
      } catch (error) {
        try {
          await writable.abort(error);
          aborted = true;
        } catch {
          // Preserve the commit error; abort is best-effort after a close failure.
        }
        throw error;
      }
    },
    async abort(reason) {
      if (aborted || committed || commitStarted) return;
      aborted = true;
      await writable.abort(reason);
    },
  };
}
