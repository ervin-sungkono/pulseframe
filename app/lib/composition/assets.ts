import { readLocalImage, type LocalImage } from "../media/local-image";

export const MAX_COMPOSITION_ASSETS = 30;
export const MAX_COMPOSITION_FOREGROUND_PIXELS = 64_000_000;

/** Release staged URLs after a failed or canceled project load. */
export function disposeStagedAssets(staged: Map<string, LocalImage>) {
  releaseImages(staged.values());
  staged.clear();
}

function releaseImages(images: Iterable<LocalImage>, retainedUrls = new Set<string>()) {
  const released = new Set<string>();
  for (const asset of images) {
    if (!retainedUrls.has(asset.url) && !released.has(asset.url)) {
      released.add(asset.url);
      URL.revokeObjectURL(asset.url);
    }
  }
}

function abortError() {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function pixelCount(images: Iterable<LocalImage>) {
  const seen = new Set<string>();
  let pixels = 0;
  for (const { image, url } of images) {
    if (seen.has(url)) continue;
    seen.add(url);
    pixels += image.naturalWidth * image.naturalHeight;
    if (!Number.isSafeInteger(pixels)) return Number.POSITIVE_INFINITY;
  }
  return pixels;
}

/** Owns decoded image elements and the object URLs that keep them available. */
export class CompositionAssetOwner {
  private owned = new Map<string, LocalImage>();
  private imageView?: ReadonlyMap<string, HTMLImageElement>;

  async prepare(
    files: Record<string, File>,
    signal?: AbortSignal,
  ): Promise<Map<string, LocalImage>> {
    const staged = new Map<string, LocalImage>();
    try {
      const entries = Object.entries(files);
      if (entries.length > MAX_COMPOSITION_ASSETS)
        throw new Error(`A composition can contain at most ${MAX_COMPOSITION_ASSETS} images.`);

      for (const [id, file] of entries) {
        if (!id || id.length > 80) throw new Error("A composition image has an invalid ID.");
        if (signal?.aborted) throw abortError();
        const localImage = await readLocalImage(file, "logo", signal);
        if (signal?.aborted) {
          URL.revokeObjectURL(localImage.url);
          throw abortError();
        }
        staged.set(id, localImage);
        if (pixelCount(staged.values()) > MAX_COMPOSITION_FOREGROUND_PIXELS)
          throw new Error("Composition images exceed the 64 megapixel limit.");
      }
      return staged;
    } catch (error) {
      disposeStagedAssets(staged);
      throw error;
    }
  }

  /** Transfer staged assets into this owner, preserving the current set on failure. */
  commit(staged: Map<string, LocalImage>, replace = false) {
    const next = replace ? new Map<string, LocalImage>() : new Map(this.owned);
    for (const [id, image] of staged) next.set(id, image);

    if (
      next.size > MAX_COMPOSITION_ASSETS ||
      pixelCount(next.values()) > MAX_COMPOSITION_FOREGROUND_PIXELS
    )
      throw new Error("Composition images exceed the 64 megapixel limit.");

    const nextUrls = new Set([...next.values()].map((image) => image.url));
    releaseImages(this.owned.values(), nextUrls);
    this.owned = next;
    this.invalidateImageView();
    staged.clear();
  }

  /** Return the same read-only map until the owned asset set changes. */
  images(): ReadonlyMap<string, HTMLImageElement> {
    if (!this.imageView) {
      this.imageView = new Map(
        [...this.owned].map(([id, localImage]) => [id, localImage.image] as const),
      );
    }
    return this.imageView;
  }

  files(): Record<string, File> {
    const result = Object.create(null) as Record<string, File>;
    for (const [id, localImage] of this.owned) result[id] = localImage.file;
    return result;
  }

  prune(retainedIds: Set<string>) {
    const next = new Map([...this.owned].filter(([id]) => retainedIds.has(id)));
    if (next.size === this.owned.size) return;
    const nextUrls = new Set([...next.values()].map((image) => image.url));
    releaseImages(this.owned.values(), nextUrls);
    this.owned = next;
    this.invalidateImageView();
  }

  dispose() {
    if (!this.owned.size) return;
    releaseImages(this.owned.values());
    this.owned.clear();
    this.invalidateImageView();
  }

  private invalidateImageView() {
    this.imageView = undefined;
  }
}
