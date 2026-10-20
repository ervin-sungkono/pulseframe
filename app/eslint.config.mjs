import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores([
    "app/dist/**",
    "build/**",
    "app/outputs/**",
    "app/work/**",
    "app/public/dsp/**",
    "app/public/mdx-ort/**",
    "app/public/whisper-ort/**",
    "crates/pulseframe-dsp/target/**",
  ]),
  { ...js.configs.recommended, files: ["**/*.{ts,tsx}"] },
  tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended, files: ["**/*.{ts,tsx}"] },
  {
    files: ["app/components/ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  eslintConfigPrettier,
]);
