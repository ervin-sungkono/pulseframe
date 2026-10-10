"use client";

import { useCallback, useRef, useState } from "react";
import type { ExportDestination } from "@/lib/export-destination";
import type { UseExportControllerResult } from "@/hooks/use-export-controller";
import { safeFilenameStem, snapshotExportRequests, type ExportRequest } from "@/lib/export-request";

export const MAX_QUEUED_EXPORT_REQUESTS = 20;

export type UseExportQueueResult = {
  requests: ExportRequest[];
  queueError: string;
  clearQueueError: () => void;
  remainingSlots: number;
  addRequest: (request: ExportRequest) => void;
  addRequests: (requests: readonly ExportRequest[]) => void;
  removeRequest: (id: string) => void;
  renameRequest: (id: string, filename: string) => void;
  moveRequest: (id: string, offset: -1 | 1) => void;
  clearRequests: () => void;
  run: (destination?: ExportDestination) => Promise<void> | null;
  retryPending: () => Promise<void> | null;
  exporting: boolean;
  runState: UseExportControllerResult["runState"];
  progress: UseExportControllerResult["progress"];
  pendingDownload: UseExportControllerResult["pendingDownload"];
  downloadPending: UseExportControllerResult["downloadPending"];
  pause: UseExportControllerResult["pauseExport"];
  resume: UseExportControllerResult["resumeExport"];
  stop: UseExportControllerResult["cancelExport"];
};

function duplicateId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function filenameKey(value: string) {
  return safeFilenameStem(value).toLocaleLowerCase("en-US");
}

function uniqueFilename(value: string, used: Set<string>) {
  const base = safeFilenameStem(value);
  let candidate = base;
  let suffix = 2;
  while (used.has(filenameKey(candidate))) {
    const tail = `-${suffix++}`;
    candidate = `${base.slice(0, 160 - tail.length)}${tail}`;
  }
  used.add(filenameKey(candidate));
  return candidate;
}

/**
 * Queue list and controls around the export controller's single lock owner.
 * Files are snapshotted when added; runtime decoders and prepared PCM are not retained.
 */
export function useExportQueue(controller: UseExportControllerResult): UseExportQueueResult {
  const [requests, setRequests] = useState<ExportRequest[]>([]);
  const requestsRef = useRef<ExportRequest[]>([]);
  const [queueError, setQueueError] = useState("");

  const addRequests = useCallback(
    (incoming: readonly ExportRequest[]) => {
      if (controller.exporting || !incoming.length) return;
      const current = requestsRef.current;
      if (current.length + incoming.length > MAX_QUEUED_EXPORT_REQUESTS) {
        setQueueError(
          `A batch can contain up to ${MAX_QUEUED_EXPORT_REQUESTS} export requests. Remove an item before adding more.`,
        );
        return;
      }
      const incomingIds = new Set(current.map((request) => request.id));
      const usedFilenames = new Set(current.map((request) => filenameKey(request.filename)));
      const disambiguated: Array<{ original: string; resolved: string }> = [];
      const uniqueIncoming = incoming.map((request) => {
        let id = request.id;
        while (incomingIds.has(id)) id = duplicateId();
        incomingIds.add(id);
        let filename: string;
        try {
          filename = uniqueFilename(request.filename, usedFilenames);
        } catch (caught) {
          setQueueError(
            caught instanceof Error ? caught.message : "Choose a valid export filename.",
          );
          return null;
        }
        if (filename !== request.filename && !disambiguated.length)
          disambiguated.push({ original: request.filename, resolved: filename });
        return { ...request, id, filename };
      });
      const validRequests = uniqueIncoming.filter(
        (request): request is ExportRequest => request !== null,
      );
      const snapshots = snapshotExportRequests(validRequests);
      if (!snapshots.length) return;
      const next = [...current, ...snapshots];
      requestsRef.current = next;
      setRequests(next);
      setQueueError(
        disambiguated.length
          ? `“${disambiguated[0].original}” was renamed to “${disambiguated[0].resolved}” to keep every output filename unique.`
          : "",
      );
    },
    [controller.exporting],
  );

  const addRequest = useCallback((request: ExportRequest) => addRequests([request]), [addRequests]);

  const removeRequest = useCallback(
    (id: string) => {
      if (controller.exporting) return;
      const next = requestsRef.current.filter((request) => request.id !== id);
      requestsRef.current = next;
      setRequests(next);
    },
    [controller.exporting],
  );

  const renameRequest = useCallback(
    (id: string, filename: string) => {
      if (controller.exporting) return;
      let safe: string;
      try {
        safe = safeFilenameStem(filename);
      } catch (caught) {
        setQueueError(caught instanceof Error ? caught.message : "Choose a valid export filename.");
        return;
      }
      const used = new Set(
        requestsRef.current
          .filter((request) => request.id !== id)
          .map((request) => filenameKey(request.filename)),
      );
      const resolved = uniqueFilename(safe, used);
      const next = requestsRef.current.map((request) =>
        request.id === id ? { ...request, filename: resolved } : request,
      );
      requestsRef.current = next;
      setRequests(next);
      setQueueError(
        resolved !== safe
          ? `“${safe}” was renamed to “${resolved}” to keep every output filename unique.`
          : "",
      );
    },
    [controller.exporting],
  );

  const moveRequest = useCallback(
    (id: string, offset: -1 | 1) => {
      if (controller.exporting) return;
      const current = requestsRef.current;
      const index = current.findIndex((request) => request.id === id);
      const nextIndex = index + offset;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      requestsRef.current = next;
      setRequests(next);
    },
    [controller.exporting],
  );

  const clearRequests = useCallback(() => {
    if (!controller.exporting) {
      requestsRef.current = [];
      setRequests([]);
      setQueueError("");
    }
  }, [controller.exporting]);

  const clearQueueError = useCallback(() => setQueueError(""), []);

  const run = useCallback(
    (destination?: ExportDestination) => {
      if (!requests.length) return null;
      return controller.runRequests(requests, destination ? { destination } : {});
    },
    [controller, requests],
  );
  const retryPending = useCallback(() => controller.retryPending(requests), [controller, requests]);

  return {
    requests,
    queueError,
    clearQueueError,
    remainingSlots: Math.max(0, MAX_QUEUED_EXPORT_REQUESTS - requests.length),
    addRequest,
    addRequests,
    removeRequest,
    renameRequest,
    moveRequest,
    clearRequests,
    run,
    retryPending,
    exporting: controller.exporting,
    runState: controller.runState,
    progress: controller.progress,
    pendingDownload: controller.pendingDownload,
    downloadPending: controller.downloadPending,
    pause: controller.pauseExport,
    resume: controller.resumeExport,
    stop: controller.cancelExport,
  };
}
