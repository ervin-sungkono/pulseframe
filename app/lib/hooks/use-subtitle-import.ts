import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_SUBTITLE_IMPORT_BYTES,
  parseSubtitleImport,
  type SubtitleImportResult,
} from "@/lib/subtitles/import";
import type { SubtitleCue } from "@/lib/subtitles/model";

type Options = {
  trackFile?: File | null;
  duration: number;
  cues: SubtitleCue[];
  disabled: boolean;
  onChange: (cues: SubtitleCue[]) => void;
};
type PendingImport = SubtitleImportResult & { filename: string; source: Options };

export function useSubtitleImport(options: Options) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const request = useRef({ generation: 0 });
  const mounted = useRef(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const lifecycle = request.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycle.generation++;
    };
  }, []);
  const current = (source: Options) =>
    source.trackFile === latest.current.trackFile &&
    source.duration === latest.current.duration &&
    source.cues === latest.current.cues;

  async function read(file: File) {
    const source = latest.current;
    if (source.disabled || !source.trackFile || source.duration <= 0) return;
    const token = ++request.current.generation;
    setPending(null);
    setError("");
    setLoading(true);
    try {
      if (file.size > MAX_SUBTITLE_IMPORT_BYTES)
        throw new Error("Subtitle files must be 2 MB or smaller.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!mounted.current || token !== request.current.generation) return;
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "utf-16be"
            : "utf-8";
      let text: string;
      try {
        text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        throw new Error("The file encoding could not be read. Save it as UTF-8 and try again.");
      }
      const result = parseSubtitleImport(text, file.name, source.duration);
      if (!mounted.current || token !== request.current.generation) return;
      if (!current(source) || latest.current.disabled)
        throw new Error("The track or subtitles changed. Import the file again.");
      setPending({ ...result, filename: file.name, source });
    } catch (caught) {
      if (mounted.current && token === request.current.generation)
        setError(caught instanceof Error ? caught.message : "The subtitle file could not be read.");
    } finally {
      if (mounted.current && token === request.current.generation) setLoading(false);
    }
  }
  function cancel() {
    request.current.generation++;
    setPending(null);
    setLoading(false);
    setError("");
  }
  function apply() {
    if (!pending || latest.current.disabled) return;
    if (!current(pending.source)) {
      setPending(null);
      setError("The track or subtitles changed. Import the file again.");
      return;
    }
    const cues = pending.cues.map((cue) => ({ ...cue, id: crypto.randomUUID() }));
    latest.current.onChange(cues);
    setPending(null);
    setError("");
  }
  return { pending, loading, error, read, apply, cancel };
}
