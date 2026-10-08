import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  globalIgnores(["dist/**", "build/**", "public/dsp/**", "crates/pulseframe-dsp/target/**"]),
  { ...js.configs.recommended, files: ["**/*.{ts,tsx}"] },
  tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended, files: ["**/*.{ts,tsx}"] },
  {
    files: ["components/ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);
