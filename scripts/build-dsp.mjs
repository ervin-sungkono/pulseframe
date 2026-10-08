import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "crates", "pulseframe-dsp");
const target = path.join(
  crate,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "pulseframe_dsp.wasm",
);
const output = path.join(root, "public", "dsp");
const staging = path.join(root, "public", ".dsp-build");
const cargoHome = path.resolve(root, process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"));
// Remap source and registry paths embedded in Wasm panic metadata. Keep these
// flags controlled so identical sources build byte-for-byte from other roots.
const buildRustFlags = [
  "--remap-path-prefix",
  `${root}=/pulseframe`,
  "--remap-path-prefix",
  `${cargoHome}=/cargo`,
].join("\x1f");

for (const variable of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]) {
  if (process.env[variable]?.trim()) {
    throw new Error(`${variable} is set; unset it before the reproducible DSP build`);
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const bindgenVersion = spawnSync("wasm-bindgen", ["--version"], { cwd: root, encoding: "utf8" });
if (bindgenVersion.error) throw bindgenVersion.error;
if (bindgenVersion.status !== 0 || bindgenVersion.stdout.trim() !== "wasm-bindgen 0.2.100") {
  throw new Error(
    `wasm-bindgen CLI 0.2.100 is required; found ${bindgenVersion.stdout.trim() || "no version output"}`,
  );
}

run(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    path.join(crate, "Cargo.toml"),
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ],
  {
    CARGO_ENCODED_RUSTFLAGS: buildRustFlags,
  },
);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
run("wasm-bindgen", [
  target,
  "--target",
  "web",
  "--out-dir",
  staging,
  "--out-name",
  "pulseframe_dsp",
]);
rmSync(output, { recursive: true, force: true });
mkdirSync(path.dirname(output), { recursive: true });
renameSync(staging, output);
