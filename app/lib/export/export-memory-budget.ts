import type { EncodedPacket } from "mediabunny";

export const DESKTOP_BUFFERED_EXPORT_LIMIT_BYTES = 128 * 1024 * 1024;
export const MOBILE_BUFFERED_EXPORT_LIMIT_BYTES = 64 * 1024 * 1024;

export function isLikelyMobileDevice() {
  if (typeof navigator === "undefined") return false;
  const userAgentData = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return (
    userAgentData.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function bufferedExportLimitBytes(isMobile = isLikelyMobileDevice()) {
  return isMobile ? MOBILE_BUFFERED_EXPORT_LIMIT_BYTES : DESKTOP_BUFFERED_EXPORT_LIMIT_BYTES;
}

/** Counts encoded output packet bytes in buffer mode and exposes a checked stop point. */
export function createEncodedPacketBudget(limitBytes: number) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0)
    throw new Error("The buffered export byte limit must be a positive safe integer.");

  let bytes = 0;
  let exceeded = false;
  return {
    onPacket(packet: EncodedPacket) {
      if (!exceeded) {
        bytes += packet.byteLength;
        if (bytes > limitBytes) exceeded = true;
      }
    },
    get bytes() {
      return bytes;
    },
    get exceeded() {
      return exceeded;
    },
    throwIfExceeded() {
      if (exceeded) {
        const limitMiB = Math.round(limitBytes / (1024 * 1024));
        throw new Error(
          `This export exceeded the ${limitMiB} MiB browser-memory limit. Choose Save to file to stream it directly, or shorten the selected section.`,
        );
      }
    },
  };
}
