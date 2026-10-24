export type LocalImage = { file: File; url: string; image: HTMLImageElement };
export async function readLocalImage(
  file: File,
  kind: "logo" | "background",
  signal?: AbortSignal,
): Promise<LocalImage> {
  const logo = kind === "logo",
    types = ["image/png", "image/jpeg", "image/webp", ...(!logo ? ["image/avif"] : [])];
  if (!types.includes(file.type) || file.size > (logo ? 8 : 20) * 1024 * 1024 || !file.size) {
    throw new Error(
      logo
        ? "Choose a PNG, JPEG, or WebP logo under 8 MB."
        : "Choose a PNG, JPEG, WebP, or AVIF background under 20 MB.",
    );
  }
  if (signal?.aborted) throw abortError();
  const url = URL.createObjectURL(file);
  let released = false;
  const releaseUrl = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(url);
  };
  let abortListener: (() => void) | undefined;
  try {
    const image = new Image();
    image.src = url;
    const decode = image.decode();
    if (signal) {
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(abortError());
        signal.addEventListener("abort", abortListener, { once: true });
      });
      await Promise.race([decode, aborted]);
    } else {
      await decode;
    }
    if (signal?.aborted) throw abortError();
    if (
      logo
        ? image.naturalWidth > 4096 || image.naturalHeight > 4096
        : image.naturalWidth * image.naturalHeight > 40000000
    ) {
      throw new Error(
        logo
          ? "Use a logo smaller than 4096 × 4096 pixels."
          : "Choose a background smaller than 40 megapixels.",
      );
    }
    return { file, url, image };
  } catch (error) {
    releaseUrl();
    throw error instanceof Error ? error : new Error("Could not read that image.");
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function abortError() {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
