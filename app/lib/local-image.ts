export type LocalImage = { file: File; url: string; image: HTMLImageElement };
export async function readLocalImage(file: File, kind: "logo" | "background"): Promise<LocalImage> {
  const logo = kind === "logo",
    types = ["image/png", "image/jpeg", "image/webp", ...(!logo ? ["image/avif"] : [])];
  if (!types.includes(file.type) || file.size > (logo ? 8 : 20) * 1024 * 1024 || !file.size) {
    throw new Error(
      logo
        ? "Choose a PNG, JPEG, or WebP logo under 8 MB."
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
          : "Choose a background smaller than 40 megapixels.",
      );
    }
    return { file, url, image };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof Error ? error : new Error("Could not read that image.");
  }
}
