import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import Home from "./components/Home";
import "./globals.css";
import "./components/Home/style.css";
import "./components/CustomizerPanel/style.css";
import "./components/QuickLookStrip/style.css";
import "./components/TrackWaveform/style.css";
import "./components/ExportDialog/style.css";
import "./components/SubtitleGenerationPanel/style.css";
import "./components/SubtitleImportPanel/style.css";
import "./components/SubtitleDialog/style.css";
import "./components/PresetDialog/style.css";
import "./components/PresetSaveDialog/style.css";

createRoot(document.getElementById("root")!).render(
  <>
    <Home />
    <Analytics />
  </>,
);
