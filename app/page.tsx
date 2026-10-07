"use client";

import { exportDimensions, type ExportResolution } from "@/lib/export-settings";

import { useEffect, useRef, useState } from "react";
import {
  AudioLines, Captions, CircleHelp, Download, FileAudio2, Film, FolderOpen, ImageDown, Pause, Play, Save, RotateCcw, Repeat2, Volume2, VolumeX, Maximize2, Minimize2,
  SlidersHorizontal, Sparkles, Upload, Bookmark, WandSparkles, X,
} from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CustomizerPanel } from "@/components/customizer-panel";
import { ExportDialog, timestamp } from "@/components/export-dialog";
import { PresetDialog } from "@/components/preset-dialog";
import { applyPreset, presetStyle, type SavedPreset } from "@/lib/presets";
import { BUILTIN_LOOKS, DEFAULT_SETTINGS, SECTION_KEYS, type CustomizerSection } from "@/lib/customizer-config";
import { QuickLookStrip, type ActiveLook } from "@/components/quick-look-strip";
import { PresetSaveDialog } from "@/components/preset-save-dialog";
import { usePresets } from "@/hooks/use-presets";
import { useSettingsHistory } from "@/hooks/use-settings-history";
import { useExportController } from "@/hooks/use-export-controller";
import { SubtitleDialog } from "@/components/subtitle-dialog";
import type { ExportFrameRate } from "@/lib/export-timeline";
import { makeProjectFile, readProjectFile } from "@/lib/project-file";
import type { SubtitleCue } from "@/lib/subtitles";
import { useMediaSession } from "@/hooks/use-media-session";
import { useVisualizerPreview } from "@/hooks/use-visualizer-preview";
import { TrackWaveform } from "@/components/track-waveform";
import type { VisualSettings } from "@/lib/visual-settings-model";

const dimensions = {
  landscape: { width: 1280, height: 720, label: "16:9", css: "16 / 9" },
  portrait: { width: 720, height: 1280, label: "9:16", css: "9 / 16" },
  square: { width: 1080, height: 1080, label: "1:1", css: "1 / 1" },
};
type Format = keyof typeof dimensions;
const friendlySize = (bytes: number) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaHostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const exportingRef = useRef(false);

  const { value: settings, setValue: setSettings, resetValue: resetSettings, undo, redo, canUndo, canRedo } = useSettingsHistory<VisualSettings>(DEFAULT_SETTINGS);
  const library = usePresets();
  const [activeLook, setActiveLook] = useState<ActiveLook | null>(null);
  const [lookSaveOpen, setLookSaveOpen] = useState(false);
  const [lookSaveTarget, setLookSaveTarget] = useState<SavedPreset | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [format, setFormat] = useState<Format>("landscape");
  const [frameRate, setFrameRate] = useState<ExportFrameRate>(30);
  const [videoCompression, setVideoCompression] = useState(false);
  const [resolution, setResolution] = useState<ExportResolution>(720);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [customizerSnap, setCustomizerSnap] = useState<number | string | null>(.62);
  const [exportOpen, setExportOpen] = useState(false);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [volume, setVolume] = useState(.7);
  const [muted, setMuted] = useState(false);
  const [looping, setLooping] = useState(false);
  const [focusView, setFocusView] = useState(false);

  const mediaSession = useMediaSession({
    getMediaHost: () => mediaHostRef.current,
    isBlocked: () => exportingRef.current,
    initialVolume: muted ? 0 : volume,
    initialLoop: looping,
    onError: ({ error: failure }) => setError(failure.message),
    onNotice: message => setNotice(message),
    onRequestFile: () => fileInputRef.current?.click(),
    onCommitted: ({ project, next, range: committedRange }) => {
      setRange(committedRange);
      if (project) {
        setFormat(project.format); setResolution(project.resolution ?? 720); setFrameRate(project.frameRate ?? 30);
        setVideoCompression(project.videoCompression ?? false); resetSettings(project.settings);
        setSubtitles(project.subtitles); setActiveLook(null);
      } else {
        setSubtitles([]);
        resetSettings(current => ({ ...current, trackTitle: next.name.replace(/\.[^.]+$/, "").slice(0, 120), trackArtist: "" }));
      }
    },
    onEvent: event => {
      if (event.type === "loading" && event.loading) { setError(""); setNotice(""); }
    },
  });
  const { session } = mediaSession;
  const file = mediaSession.file;
  const duration = mediaSession.duration;
  const position = mediaSession.position;
  const playing = mediaSession.playing;
  const loadingMedia = mediaSession.loadingMedia;
  const logoName = mediaSession.logoName, logoUrl = mediaSession.logoUrl;
  const backgroundName = mediaSession.backgroundName, backgroundUrl = mediaSession.backgroundUrl;
  const setMediaVolume = mediaSession.setVolume, setMediaLoop = mediaSession.setLoop;
  const snapshot = mediaSession.snapshot;
  const isVideo = !!snapshot.video;
  const preparedSound = snapshot.sound;
  const { captureImage, reducedMotionRef } = useVisualizerPreview({
    session, canvasRef, settings, subtitles, format, lockedRef: exportingRef, onError: setError, onNotice: setNotice,
  });
  const { exporting, progress, exportVideo, cancelExport } = useExportController({
    lockedRef: exportingRef,
    getSource: () => {
      const current = session.snapshot;
      if (loadingMedia || openingProject || !current.file || !current.duration) return null;
      return {
        file: current.file,
        duration: current.duration,
        range,
        format,
        resolution,
        frameRate,
        videoCompression,
        settings,
        subtitles,
        logo: current.logo?.image ?? null,
        background: current.background?.image ?? null,
        prepared: current.sound ?? undefined,
        reducedMotion: reducedMotionRef.current,
      };
    },
    pausePlayback: () => session.pause(),
    onError: setError,
    onNotice: setNotice,
    onComplete: () => setExportOpen(false),
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("presets") === "1") setPresetOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    setMediaVolume(muted ? 0 : volume);
  }, [volume, muted, setMediaVolume]);
  useEffect(() => { setMediaLoop(looping); }, [looping, setMediaLoop]);

  const update = <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) =>
    { if (!exportingRef.current) setSettings(current => ({ ...current, [key]: value }), key); };
  const applyLook = (changes: Partial<VisualSettings>) => { if (!exportingRef.current) setSettings(current => ({ ...current, ...changes })); };
  const applySavedLook = (preset: SavedPreset) => {
    if (exportingRef.current) return;
    setSettings(current => applyPreset(current, preset.settings));
    setActiveLook({ id: preset.id, name: preset.name, settings: preset.settings, preset });
    setNotice(`Applied “${preset.name}”.`);
  };
  const applyBuiltinLook = (look: (typeof BUILTIN_LOOKS)[number]) => {
    if (exportingRef.current) return;
    setSettings(current => applyPreset(current, look.settings));
    setActiveLook({ id: look.id, name: look.name, settings: look.settings });
    setNotice(`Applied “${look.name}”.`);
  };
  const resetAppearance = () => {
    if (exportingRef.current) return;
    setSettings(current => applyPreset(current, presetStyle(DEFAULT_SETTINGS)));
    setActiveLook(null); setNotice("Appearance reset. Your track text and project assets are preserved.");
  };
  const resetSection = (section: CustomizerSection) => {
    if (exportingRef.current) return;
    const baseline = activeLook?.settings ?? presetStyle(DEFAULT_SETTINGS);
    setSettings(current => {
      const next = { ...current };
      for (const key of SECTION_KEYS[section]) {
        if (key === "trackTitle" || key === "trackArtist") continue;
        Object.assign(next, { [key]: structuredClone(baseline[key as keyof typeof baseline]) });
      }
      return next;
    });
    setNotice(`Reset ${section} settings to ${activeLook ? `“${activeLook.name}”` : "defaults"}.`);
  };
  const currentPreset = activeLook?.preset
    ? library.pinnedPresets.find(item => item.id === activeLook.id) ?? library.presets.find(item => item.id === activeLook.id) ?? activeLook.preset : null;
  const currentLook = activeLook ? { ...activeLook, name: currentPreset?.name ?? activeLook.name, preset: currentPreset ?? undefined } : null;
  const lookModified = !!activeLook && JSON.stringify(presetStyle(settings)) !== JSON.stringify(presetStyle(activeLook.settings));
  const saveQuickLook = (target: SavedPreset | null = null) => { setLookSaveTarget(target); setLookSaveOpen(true); };
  const lookSaved = (preset: SavedPreset) => {
    setActiveLook({ id: preset.id, name: preset.name, settings: preset.settings, preset });
    setNotice(`Saved “${preset.name}”.`);
  };
  const lookMetadataChanged = (preset: SavedPreset) => {
    setActiveLook(current => current?.id === preset.id ? { ...current, name: preset.name, preset } : current);
  };
  const quickLooks = <QuickLookStrip settings={settings} library={library} active={currentLook} modified={lookModified}
    disabled={exporting} canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo}
    onApplyBuiltin={applyBuiltinLook} onApplyPreset={applySavedLook} onSave={() => saveQuickLook()}
    onUpdate={preset => saveQuickLook(preset)} onManage={() => setPresetOpen(true)} onPresetChanged={lookMetadataChanged}/>;
  const loadFile = mediaSession.loadFile;
  const seek = mediaSession.seek;
  const togglePlay = mediaSession.togglePlay;
  const changeLogo = mediaSession.changeLogo;
  const changeBackground = mediaSession.changeBackground;
  const previewRange = async () => {
    if (await mediaSession.previewRange(range)) setExportOpen(false);
  };

  const saveProject = () => {
    const current = session.snapshot;
    if (!current.file || exportingRef.current) return;
    try {
      const blob = makeProjectFile({ media: current.file, logo: current.logo?.file ?? null, background: current.background?.file ?? null,
        settings, subtitles, format, resolution, frameRate, videoCompression, range });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${current.file.name.replace(/\.[^.]+$/, "")}-pulseframe.pulseframe`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setProjectOpen(false); setNotice("Project file saved with your media and edits.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save project."); }
  };
  const openProject = async (projectFile: File | undefined) => {
    if (!projectFile || exportingRef.current || openingProject) return;
    setOpeningProject(true); setError("");
    const currentLoad = session.requestGeneration;
    try {
      const project = await readProjectFile(projectFile);
      if (currentLoad !== session.requestGeneration) return;
      if (!await loadFile(project.media, project.range, project)) return;
      setProjectOpen(false);
      setNotice(project.migratedStyle
        ? `Opened ${projectFile.name}. Its older visual style now uses ${project.settings.mode === "ring" ? "Pulse Ring" : "Spectrum"}.`
        : `Opened ${projectFile.name}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open project."); }
    finally { setOpeningProject(false); }
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && focusView) { setFocusView(false); return; }
      if (customizerOpen || exportOpen || subtitleOpen || projectOpen || presetOpen || lookSaveOpen || helpOpen || exporting || loadingMedia) return;
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,button,[role="slider"],[contenteditable="true"],[role="dialog"]')) return;
      if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); seek((session.snapshot.media?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 5 : -5));
      }
    };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  }, [customizerOpen, exportOpen, subtitleOpen, projectOpen, presetOpen, lookSaveOpen, helpOpen, exporting, loadingMedia, focusView, seek, session, togglePlay]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || exporting || loadingMedia || presetOpen || lookSaveOpen || exportOpen || subtitleOpen || projectOpen || helpOpen) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (key === "y") { event.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exporting, loadingMedia, presetOpen, lookSaveOpen, exportOpen, subtitleOpen, projectOpen, helpOpen, undo, redo]);

  const canvas = dimensions[format];
  const outputDimensions = exportDimensions(format, resolution);
  return <main className={`studio-shell ${focusView ? "focus-view" : ""}`}>
    <header className="topbar">
      <div className="brand" aria-label="Pulseframe"><span className="brand-mark"><AudioLines size={22} strokeWidth={2.3}/></span><span>pulseframe<span className="brand-dot">.</span></span></div>
      <div className="topbar-center"><span className="eyebrow-line"/> MUSIC VISUALIZER STUDIO <span className="eyebrow-line"/></div>
      <div className="topbar-actions">
        <button className="text-button help-button" onClick={() => setHelpOpen(true)}><CircleHelp size={17}/><span>How it works</span></button>
        <button className="text-button preset-button" aria-label="My presets" onClick={() => setPresetOpen(true)} disabled={exporting}><Bookmark size={17}/><span>Presets</span></button>
        <button className="text-button project-button" aria-label="Project files" onClick={() => setProjectOpen(true)} disabled={exporting || openingProject || loadingMedia}><FolderOpen size={17}/><span>Project</span></button>
        <button className="button button-soft import-top" aria-label="Import media" onClick={() => fileInputRef.current?.click()} disabled={exporting || loadingMedia}><Upload size={16}/><span>Import media</span></button>
      </div>
    </header>
    <div className="workspace">
      <section className="preview-column" aria-label="Visualizer preview">
        <div className="section-heading"><div><p className="kicker">WORKSPACE / 01</p><h1>Your visualizer</h1></div><div className="live-pill"><span/> {exporting ? "EXPORTING" : file ? "LIVE PREVIEW" : "DEMO PREVIEW"}</div></div>
        <div className={`preview-wrap ${format} ${dragging ? "is-dragging" : ""}`}
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); setDragging(false); const dropped = event.dataTransfer.files[0]; if (dropped?.type.startsWith("image/")) changeBackground(dropped); else loadFile(dropped); }}>
          <div className="preview-stage" style={{ aspectRatio: canvas.css }}>
            <canvas ref={canvasRef} width={1280} height={720} aria-label="Audio reactive visualization"/>
            <div className="stage-corner top-left"><span className="stage-indicator"/> {file ? "AUDIO REACTIVE" : "DEMO MODE"}</div>
            <div className="stage-corner top-right">PF / {canvas.label}</div>
            <div className="stage-corner bottom-left">{settings.mode.toUpperCase()} <span className="stage-separator">/</span> {settings.particleMode.toUpperCase()}</div>
            <div className="stage-corner bottom-right">{file ? timestamp(position) : "0:00"}</div>
            {loadingMedia && <div className="media-loading" role="status">Preparing your media…</div>}
            {dragging && <div className="drop-overlay"><Upload size={30}/><strong>Drop media or a background image</strong></div>}
          </div>
        </div>
        <div className="stage-toolbar">
          <span className="toolbar-label">CANVAS SIZE</span>
          <div className="segmented" role="group" aria-label="Canvas aspect ratio">
            {(Object.keys(dimensions) as Format[]).map(key => <button key={key} className={format === key ? "active" : ""} onClick={() => setFormat(key)} disabled={exporting} aria-pressed={format === key}>{dimensions[key].label}</button>)}
          </div>
          <div className="toolbar-spacer"/>
          <button className="icon-text-button" onClick={() => setFocusView(value => !value)} aria-label={focusView ? "Exit focus view" : "Focus preview"} aria-pressed={focusView}>{focusView ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>
          <button className="icon-text-button" aria-label={`Edit subtitles${subtitles.length ? `, ${subtitles.length} blocks` : ""}`} onClick={() => setSubtitleOpen(true)} disabled={!file || exporting}><Captions size={17}/><span>Subtitles{subtitleOpen || !subtitles.length ? "" : ` (${subtitles.length})`}</span></button>
          <button className="icon-text-button" onClick={captureImage} title="Save current frame"><ImageDown size={16}/><span>Save frame</span></button>
        </div>
        <div className="transport-card">
          <div className="track-details">
            <div className="track-icon">{isVideo ? <Film size={19}/> : <FileAudio2 size={19}/>}</div>
            <div className="track-copy"><strong>{file ? file.name : "No media uploaded yet"}</strong><span>{file ? `${isVideo ? "VIDEO" : "AUDIO"} · ${friendlySize(file.size)}` : "Upload a song or video to bring the visual to life"}</span></div>
            {!file && <button className="replace-button" disabled={loadingMedia} onClick={async () => { const { makeDemoFile } = await import("@/lib/demo-file"); await loadFile(makeDemoFile()); }}>Try sample</button>}
            {file && <button className="replace-button" onClick={() => fileInputRef.current?.click()} disabled={exporting || loadingMedia}>Replace</button>}
          </div>
          {preparedSound?.overview.length ? <TrackWaveform overview={preparedSound.overview} position={position} duration={duration} audioDuration={preparedSound.audio?.duration ?? duration} onSeek={seek} disabled={exporting || loadingMedia}/> : null}
          <div className="player">
            <button className="play-button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={exporting || loadingMedia}>{playing ? <Pause size={19} fill="currentColor"/> : <Play size={19} fill="currentColor"/>}</button>
            <span className="time-code">{timestamp(position)}</span>
            <Slider className="studio-slider seek-slider" aria-label="Playback position" value={[Math.min(position, duration || 0)]}
              min={0} max={duration || 1} step={.1} disabled={!file || exporting || loadingMedia}
              onValueChange={values => seek(values[0])}/>
            <span className="time-code">{timestamp(duration)}</span>
          </div>
          <div className="player-options">
            <button onClick={() => seek(0)} aria-label="Restart track" disabled={!file || exporting}><RotateCcw size={17}/></button>
            <button onClick={() => setLooping(value => !value)} aria-label="Loop track" aria-pressed={looping} className={looping ? 'active' : ''} disabled={!file || exporting}><Repeat2 size={18}/></button>
            <span className="player-options-spacer"/>
            <button onClick={() => { if (muted || !volume) { setMuted(false); if (!volume) setVolume(.7); } else setMuted(true); }} aria-label={muted || !volume ? 'Unmute playback' : 'Mute playback'} aria-pressed={muted || !volume}>{muted || !volume ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button>
            <Slider className="studio-slider volume-slider" aria-label="Playback volume" value={[muted ? 0 : volume * 100]} min={0} max={100} step={1} onValueChange={values => { setMuted(false); setVolume(values[0] / 100); }}/>
            <output className="volume-readout">{Math.round((muted ? 0 : volume) * 100)}%</output>
          </div>
        </div>
        <div className="privacy-note"><Sparkles size={15}/><span>Made in your browser. Your media is never uploaded to a server.</span></div>
      </section>
      <aside className="controls desktop-controls" aria-label="Customization controls">
        <div className="panel-header"><div><p className="kicker">CONTROL ROOM / 02</p><h2>Customize</h2></div><SlidersHorizontal size={19}/></div>
        <CustomizerPanel settings={settings} onChange={update} isVideo={isVideo}
          quickLooks={quickLooks} disabled={exporting} onPatch={applyLook} onResetSection={resetSection}
          logoName={logoName} logoUrl={logoUrl} onLogoFile={changeLogo}
          backgroundName={backgroundName} backgroundUrl={backgroundUrl} onBackgroundFile={changeBackground} onReset={resetAppearance}/>
        <div className="export-panel">
          <div className="export-title"><div><WandSparkles size={18}/><strong>Ready to share?</strong></div><span>{canvas.width} × {canvas.height}</span></div>
          <button className="button export-button" onClick={() => setExportOpen(true)} disabled={!file || !duration || exporting || loadingMedia}><Download size={18}/> Export video</button>
          <p>{file ? "Choose a time range and render a video with sound." : "Add media to enable video export."}</p>
        </div>
      </aside>
    </div>
    <div className="mobile-action-dock">
      <button className="button button-soft" onClick={() => { setCustomizerSnap(.62); setCustomizerOpen(true); }}><SlidersHorizontal size={17}/> Customize</button>
      <button className="button export-button" onClick={() => setExportOpen(true)} disabled={!file || !duration || exporting || loadingMedia}><Download size={17}/> Export video</button>
    </div>
    <Drawer open={customizerOpen} onOpenChange={setCustomizerOpen}
      direction="bottom" snapPoints={[.62, .94]} activeSnapPoint={customizerSnap} setActiveSnapPoint={setCustomizerSnap}
      handleOnly>
      <DrawerContent className="mobile-customizer-drawer" data-expanded={customizerSnap === .94} showHandle={false}>
        <div className="mobile-drawer-viewport">
          <div className="mobile-drawer-top">
            <DrawerHandle className="mobile-drawer-grip" preventCycle aria-hidden={false}
              role="slider" tabIndex={0} aria-label="Customization drawer height"
              aria-valuemin={62} aria-valuemax={94} aria-valuenow={customizerSnap === .94 ? 94 : 62}
              aria-valuetext={customizerSnap === .94 ? "Expanded" : "Compact"}
              onKeyDown={event => {
                if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  setCustomizerSnap(event.key === "ArrowUp" || event.key === "End" ? .94 : .62);
                }
              }}>
              <span className="mobile-grip-bar"/>
              <span className="mobile-grip-hint">{customizerSnap === .94 ? "Drag down to shrink" : "Drag up to expand"}</span>
            </DrawerHandle>
          </div>
          <DrawerHeader><DrawerTitle>Customize visualizer</DrawerTitle>
            <DrawerDescription>Adjust the look while the preview stays visible above.</DrawerDescription></DrawerHeader>
          <CustomizerPanel settings={settings} onChange={update} isVideo={isVideo}
            quickLooks={quickLooks} disabled={exporting} onPatch={applyLook} onResetSection={resetSection}
            logoName={logoName} logoUrl={logoUrl} onLogoFile={changeLogo}
          backgroundName={backgroundName} backgroundUrl={backgroundUrl} onBackgroundFile={changeBackground} onReset={resetAppearance}/>
          <button className="button done-button" onClick={() => setCustomizerOpen(false)}>Done</button>
        </div>
      </DrawerContent>
    </Drawer>
    <ExportDialog open={exportOpen} onOpenChange={setExportOpen} duration={duration} range={range} onRangeChange={setRange}
      dimensions={outputDimensions} videoCompression={videoCompression} onVideoCompressionChange={setVideoCompression} frameRate={frameRate} onFrameRateChange={setFrameRate} resolution={resolution} onResolutionChange={setResolution}
      exporting={exporting} progress={progress} onExport={exportVideo}
      onCancel={cancelExport} onPreview={previewRange}/>
    <SubtitleDialog open={subtitleOpen} onOpenChange={setSubtitleOpen} cues={subtitles} onChange={setSubtitles}
      position={position} duration={duration} onSeek={time => { session.pause(); seek(time); }}/>
    <PresetDialog open={presetOpen} onOpenChange={setPresetOpen} settings={settings} hasMedia={!!file} library={library} currentPreset={currentPreset}
      onApply={applySavedLook} onSaved={lookSaved} onMetadataChanged={lookMetadataChanged} onDeleted={id => { setActiveLook(current => current?.id === id ? null : current); }}
      onHelp={() => { setPresetOpen(false); setHelpOpen(true); }}
      onOpenProject={() => { setPresetOpen(false); setProjectOpen(true); }}/>
    <PresetSaveDialog open={lookSaveOpen} onOpenChange={setLookSaveOpen} settings={settings} library={library}
      hasMedia={!!file} pinned={lookSaveTarget ? undefined : true} target={lookSaveTarget} onSaved={lookSaved}/>
    <Dialog open={projectOpen} onOpenChange={setProjectOpen}>
      <DialogContent className="project-dialog">
        <DialogHeader><div className="dialog-icon"><FolderOpen size={19}/></div><DialogTitle>Your project</DialogTitle>
          <DialogDescription>Keep your visualizer, subtitles, logo, background, and source media together in one file.</DialogDescription></DialogHeader>
        <div className="project-actions">
          <div><strong>Save this project</strong><span>{file ? `Includes ${file.name} (${friendlySize(file.size)})` : "Import media first to save a project."}</span>
            <button className="button button-soft" onClick={saveProject} disabled={!file || openingProject || loadingMedia}><Save size={16}/> Save project file</button></div>
          <div><strong>Open a project</strong><span>Continue from a .pulseframe file saved on your device.</span>
            <button className="button button-soft" onClick={() => projectInputRef.current?.click()} disabled={openingProject}><FolderOpen size={16}/> {openingProject ? "Opening…" : "Choose project file"}</button></div>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="help-dialog">
        <DialogHeader><DialogTitle>Make a visual in three steps</DialogTitle><DialogDescription>Upload media, choose a look, then export any section of the timeline.</DialogDescription></DialogHeader>
        <p>Add optional track details and timed subtitles in the editor. Save a project file to continue later. Video export renders the chosen section directly, without playing through the full song. Your media stays in this browser.</p>
      </DialogContent>
    </Dialog>
    <input ref={fileInputRef} type="file" accept="audio/*,video/*,.mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4,.mov" hidden
      onChange={event => { loadFile(event.target.files?.[0]); event.target.value = ""; }}/>
    <input ref={projectInputRef} type="file" accept=".pulseframe,application/x-pulseframe" hidden
      onChange={event => { void openProject(event.target.files?.[0]); event.target.value = ""; }}/>
    <div ref={mediaHostRef} aria-hidden="true" hidden/>
    {error && <div className="toast error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15}/></button></div>}
    {notice && <div className="toast success" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15}/></button></div>}
  </main>;
}
