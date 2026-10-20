const TIMESTAMP_PART = /^\d+(\.\d+)?$/;

/** Format a non-negative time in seconds as minutes and seconds. */
export function formatTimestamp(value: number, precise = false) {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(seconds / 60);
  const rest = precise
    ? (seconds % 60).toFixed(1).padStart(4, "0")
    : String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${rest}`;
}

/** Parse seconds or minutes:seconds using the editor's existing input format. */
export function parseTimestamp(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (parts.length > 2 || parts.some((part) => !TIMESTAMP_PART.test(part))) return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) ? seconds : null;
}
