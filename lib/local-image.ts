export type LocalImage = { file: File; url: string; image: HTMLImageElement };
export type LocalImageKind = "logo" | "background" | "artwork";

export async function readLocalImage(file: File, kind: LocalImageKind): Promise<LocalImage> {
  const logo = kind === "logo";
  const types = ["image/png", "image/jpeg", "image/webp", ...(!logo ? ["image/avif"] : [])];
  const maximumBytes = logo ? 8 : 20;
  if (!types.includes(file.type) || file.size > maximumBytes * 1024 * 1024 || !file.size) {
    throw new Error(
      logo
        ? "Choose a PNG, JPEG, or WebP logo under 8 MB."
        : kind === "artwork"
          ? "Choose PNG, JPEG, WebP, or AVIF cover art under 20 MB."
          : "Choose a PNG, JPEG, WebP, or AVIF background under 20 MB.",
    );
  }
  const url = URL.createObjectURL(file),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (
      logo
        ? image.naturalWidth > 4096 || image.naturalHeight > 4096
        : image.naturalWidth * image.naturalHeight > 40000000
    ) {
      throw new Error(
        logo
          ? "Use a logo smaller than 4096 × 4096 pixels."
          : kind === "artwork"
            ? "Choose cover art smaller than 40 megapixels."
            : "Choose a background smaller than 40 megapixels.",
      );
    }
    return { file, url, image };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof Error ? error : new Error("Could not read that image.");
  }
}
