import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores([
    "dist/**",
    "build/**",
    "outputs/**",
    "work/**",
    "src/public/dsp/**",
    "src/public/mdx-ort/**",
    "src/public/whisper-ort/**",
    "crates/pulseframe-dsp/target/**",
  ]),
  { ...js.configs.recommended, files: ["**/*.{ts,tsx}"] },
  tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended, files: ["**/*.{ts,tsx}"] },
  eslintConfigPrettier,
  { rules: { "eol-last": ["error", "always"] } },
]);
