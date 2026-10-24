import { loadSources } from "./load-source.mjs";

export async function loadMediaSessionSource() {
  const modules = await loadSources();
  return modules["media-session"];
}
