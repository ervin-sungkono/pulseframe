import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromProject = createRequire(join(projectRoot, "app", "package.json"));
const transformersEntry = requireFromProject.resolve("@huggingface/transformers");
const requireFromTransformers = createRequire(transformersEntry);

function findOrtDist(entry) {
  return dirname(entry);
}

function findPackageRoot(distDirectory) {
  return dirname(distDirectory);
}

async function copyRuntime(label, entry, publicDirectory) {
  const distDirectory = findOrtDist(entry);
  const packageRoot = findPackageRoot(distDirectory);
  const packageInfo = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const runtimeFiles = (await readdir(distDirectory)).filter(
    (file) => file.startsWith("ort-wasm") && (file.endsWith(".wasm") || file.endsWith(".mjs")),
  );
  if (
    !runtimeFiles.some((file) => file.endsWith(".wasm")) ||
    !runtimeFiles.some((file) => file.endsWith(".mjs"))
  )
    throw new Error(`Could not find ONNX Runtime WASM assets for ${label} in ${distDirectory}.`);

  const destination = join(projectRoot, "app", "public", publicDirectory);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of runtimeFiles) await cp(join(distDirectory, file), join(destination, file));
  console.log(
    `Prepared ${label} ONNX Runtime ${packageInfo.version}: ${publicDirectory} (${runtimeFiles.length} files).`,
  );
}

const mdxEntry = requireFromProject.resolve("onnxruntime-web");
const whisperEntry = requireFromTransformers.resolve("onnxruntime-web");

await copyRuntime("MDX", mdxEntry, "mdx-ort");
await copyRuntime("Whisper", whisperEntry, "whisper-ort");
