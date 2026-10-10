import { useCallback, useEffect, useRef, useState } from "react";
import { renderStillRequest } from "./use-export-controller";
import type { ExportRequest } from "@/lib/export-request";

/** Owns temporary preview work and its object URL independently of the editor playhead. */
export function useReleasePreview(beforePrepare: () => void) {
  const active = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<{
    label: string;
    url: string | null;
    error: string;
  } | null>(null);
  const clearResources = useCallback(() => {
    active.current?.abort();
    active.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);
  useEffect(() => clearResources, [clearResources]);
  const close = useCallback(() => {
    clearResources();
    setPreview(null);
  }, [clearResources]);
  const inspect = async (request: ExportRequest) => {
    clearResources();
    const controller = new AbortController();
    active.current = controller;
    setPreview({ label: request.label, url: null, error: "" });
    beforePrepare();
    try {
      const blob = await renderStillRequest(request, controller.signal);
      if (controller.signal.aborted || active.current !== controller) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setPreview({ label: request.label, url, error: "" });
    } catch (error) {
      if (!controller.signal.aborted && active.current === controller)
        setPreview({
          label: request.label,
          url: null,
          error: error instanceof Error ? error.message : "Could not preview this output.",
        });
    }
  };
  return { preview, inspect, close };
}
