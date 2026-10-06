"use client";

import { exportDimensions, type ExportResolution } from "@/lib/export-settings";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { SubtitleDialog } from "@/components/subtitle-dialog";
import type { ExportProgress } from "@/lib/export-video";
import type { ExportFrameRate } from "@/lib/export-timeline";
import { makeProjectFile, readProjectFile, type ProjectContent } from "@/lib/project-file";
import type { SubtitleCue } from "@/lib/subtitles";
import { PcmFeatures, audibleMediaTime, dropEnvelope, prepareSound, type PreparedSound, type SoundFrame } from "@/lib/audio-features";
import { ANALYSIS_FPS } from "@/lib/audio-analysis-config";
import { readLocalImage, type LocalImage } from "@/lib/local-image";
import { LiveSound } from "@/lib/live-sound";
import { TrackWaveform } from "@/components/track-waveform";
import { createAudioReactiveState, drawVisualization, soundResponse, warmSoundResponse, makeParticles } from "@/lib/visualizer";
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
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const logoUrlRef = useRef<string | null>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const logoFileRef = useRef<File | null>(null);
  const logoLoadRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const monitorRef = useRef<GainNode | null>(null);
  const soundRef = useRef<PreparedSound | null>(null);
  const featuresRef = useRef<PcmFeatures | null>(null);
  const liveSoundRef = useRef<LiveSound | null>(null);
  const soundFrameRef = useRef<SoundFrame | null>(null);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const backgroundFileRef = useRef<File | null>(null);
  const backgroundUrlRef = useRef<string | null>(null);
  const backgroundLoadRef = useRef(0);
  const mediaLoadRef = useRef(0);
  const mediaLoadAbortRef = useRef<AbortController | null>(null);
  const reducedMotionRef = useRef(false);
  const volumeRef = useRef(.7);
  const loopRef = useRef(false);
  const dropRef = useRef(0);
  const lastAudioRef = useRef(0);
  const audioStateRef = useRef(createAudioReactiveState());
  const particleRef = useRef(makeParticles(300));
  const frequencyRef = useRef(new Uint8Array(2048));
  const waveRef = useRef(new Uint8Array(4096).fill(128));
  const frameTimeRef = useRef(0);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const subtitlesRef = useRef<SubtitleCue[]>([]);
  const durationRef = useRef(0);
  const exportingRef = useRef(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const segmentEndRef = useRef<number | null>(null);

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
  const [file, setFile] = useState<File | null>(null);
  const [logoName, setLogoName] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
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
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [preparedSound, setPreparedSound] = useState<PreparedSound | null>(null);
  const [backgroundName, setBackgroundName] = useState<string | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [volume, setVolume] = useState(.7);
  const [muted, setMuted] = useState(false);
  const [looping, setLooping] = useState(false);
  const [focusView, setFocusView] = useState(false);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("presets") === "1") setPresetOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const currentSettings = settingsRef.current;
    if (mediaRef.current?.paused) {
      const time = Math.floor(mediaRef.current.currentTime * ANALYSIS_FPS) / ANALYSIS_FPS;
      if (soundRef.current) {
        const history = warmSoundResponse(soundRef.current.envelopes, currentSettings, time);
        audioStateRef.current = history.state;
        const frame = featuresRef.current?.at(time);
        if (frame) soundResponse(frame, currentSettings, audioStateRef.current, (time - history.lastTime) * 1000);
      } else if (soundFrameRef.current) {
        audioStateRef.current = createAudioReactiveState();
        soundResponse(soundFrameRef.current, currentSettings, audioStateRef.current, 1000);
      }
      lastAudioRef.current = time;
    }
  }, [settings.sensitivity, settings.quietThreshold, settings.bassBoost, settings.responseStyle]);
  useEffect(() => { subtitlesRef.current = subtitles; }, [subtitles]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => {
    volumeRef.current = muted ? 0 : volume;
    const context = audioContextRef.current;
    if (context && monitorRef.current) monitorRef.current.gain.setTargetAtTime(volumeRef.current, context.currentTime, .015);
  }, [volume, muted]);
  useEffect(() => { loopRef.current = looping; if (mediaRef.current) mediaRef.current.loop = looping; }, [looping]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { reducedMotionRef.current = preference.matches; };
    update(); preference.addEventListener('change', update); return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    let frame = 0, last = 0, lastUi = 0;
    const demoFrequency = new Uint8Array(2048), demoWave = new Uint8Array(4096);
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (document.hidden || now - last < 1000 / 30 - 1) return;
      const delta = Math.min(100, now - last); last = now;
      if (!exportingRef.current) {
        const media = mediaRef.current;
        const visualTime = media ? audibleMediaTime(media, audioContextRef.current, now) : now / 1000;
        const analysisTime = Math.floor(visualTime * ANALYSIS_FPS) / ANALYSIS_FPS;
        if (analysisTime < lastAudioRef.current) { audioStateRef.current = createAudioReactiveState(); liveSoundRef.current?.reset(); }
        const audioDelta = media ? (media.paused ? 0 : Math.max(0, Math.min(.25, analysisTime - lastAudioRef.current)) * 1000) : delta;
        lastAudioRef.current = analysisTime;
        let frequency: Uint8Array = demoFrequency, wave: Uint8Array = demoWave;
        const live = liveSoundRef.current && media && !media.paused ? liveSoundRef.current.at(analysisTime) : null;
        const sound = featuresRef.current?.at(analysisTime) ?? live?.sound ?? (liveSoundRef.current ? soundFrameRef.current : null);
        if (sound) { frequency = sound.frequency; wave = sound.wave; }
        else if (media) { demoFrequency.fill(0); demoWave.fill(128); }
        else {
          for (let i = 0; i < demoFrequency.length; i++) {
            demoFrequency[i] = Math.max(0, Math.min(255, (73 + 49 * Math.sin(i * .065 + now * .0017) + 26 * Math.sin(i * .015 - now * .0012)) * Math.exp(-i / 180)));
          }
          for (let i = 0; i < demoWave.length; i++) demoWave[i] = 128 + 32 * Math.sin(i * .033 + now * .002) * Math.sin(i * .009 - now * .0007);
        }
        soundFrameRef.current = sound;
        dropRef.current = media && !media.paused ? (live?.drop ?? dropEnvelope(soundRef.current?.events ?? [], visualTime)) : 0;
        frequencyRef.current.set(frequency); waveRef.current.set(wave); frameTimeRef.current = visualTime;
        drawVisualization(context, settingsRef.current, frequency, wave, particleRef.current,
          visualTime, audioDelta, videoRef.current, logoRef.current, audioStateRef.current,
          sound?.sampleRate ?? 48000, durationRef.current, subtitlesRef.current,
          { sound, background: backgroundRef.current, drop: dropRef.current, reducedMotion: reducedMotionRef.current });
      }
      const element = mediaRef.current;
      if (element && now - lastUi > 150) {
        const current = element.currentTime || 0; setPosition(current);
        if (segmentEndRef.current !== null && current >= segmentEndRef.current - .04) {
          element.pause(); segmentEndRef.current = null;
        }
        lastUi = now;
      }
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const target = dimensions[format];
      const maxEdge = window.innerWidth <= 860 ? 900 : 1280;
      const scale = Math.min(1, maxEdge / Math.max(target.width, target.height));
      canvas.width = Math.round(target.width * scale);
      canvas.height = Math.round(target.height * scale);
    };
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [format]);
  useEffect(() => () => {
    exportAbortRef.current?.abort();
    mediaRef.current?.pause(); mediaRef.current?.remove();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current);
    logoLoadRef.current++; backgroundLoadRef.current++; mediaLoadRef.current++;
    mediaLoadAbortRef.current?.abort();
    liveSoundRef.current?.dispose();
    if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
    audioContextRef.current?.close();
  }, []);

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
  const commitLogo = (asset: LocalImage | null) => {
    if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current);
    logoRef.current = asset?.image ?? null; logoFileRef.current = asset?.file ?? null; logoUrlRef.current = asset?.url ?? null;
    setLogoName(asset?.file.name ?? null); setLogoUrl(asset?.url ?? null);
  };
  const commitBackground = (asset: LocalImage | null) => {
    if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
    backgroundRef.current = asset?.image ?? null; backgroundFileRef.current = asset?.file ?? null; backgroundUrlRef.current = asset?.url ?? null;
    setBackgroundName(asset?.file.name ?? null); setBackgroundUrl(asset?.url ?? null);
  };
  const changeLogo = async (next: File | null) => {
    if (exportingRef.current) return;
    const request = ++logoLoadRef.current;
    if (!next) { commitLogo(null); return; }
    try {
      const asset = await readLocalImage(next, 'logo');
      if (request !== logoLoadRef.current || exportingRef.current) { URL.revokeObjectURL(asset.url); return; }
      commitLogo(asset); setError('');
    } catch (error) { if (request === logoLoadRef.current) setError(error instanceof Error ? error.message : 'Could not read that logo.'); }
  };
  const changeBackground = async (next: File | null) => {
    if (exportingRef.current) return;
    const request = ++backgroundLoadRef.current;
    if (!next) { commitBackground(null); return; }
    try {
      const asset = await readLocalImage(next, 'background');
      if (request !== backgroundLoadRef.current || exportingRef.current) { URL.revokeObjectURL(asset.url); return; }
      commitBackground(asset); setError('');
    } catch (error) { if (request === backgroundLoadRef.current) setError(error instanceof Error ? error.message : 'Could not read that background.'); }
  };

  const loadFile = useCallback(async (next: File | undefined, savedRange?: [number, number], project?: ProjectContent) => {
    if (!next || exportingRef.current) return false;
    const video = next.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(next.name);
    const audio = next.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(next.name);
    if ((!video && !audio) || !next.size) { setError('Choose a nonempty audio or video file.'); return false; }
    const request = ++mediaLoadRef.current;
    mediaLoadAbortRef.current?.abort();
    const controller = new AbortController(); mediaLoadAbortRef.current = controller;
    setLoadingMedia(true); setError(''); setNotice('');
    const element = document.createElement(video ? 'video' : 'audio');
    const url = URL.createObjectURL(next);
    const candidates: { logo: LocalImage | null; background: LocalImage | null } = { logo: null, background: null };
    let committed = false;
    try {
      element.preload = 'auto'; if (video) (element as HTMLVideoElement).playsInline = true;
      const ready = new Promise<void>((resolve, reject) => {
        element.onloadeddata = () => { element.onloadeddata = null; resolve(); };
        element.onerror = () => reject(new Error('This browser could not open the media. Try MP3, WAV, MP4, or WebM.'));
        controller.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
      });
      element.src = url;
      // Validate all replacement assets before releasing the current project.
      const assets = project ? Promise.allSettled([
        project.logo ? readLocalImage(project.logo, 'logo').then(a => { candidates.logo = a; }) : Promise.resolve(),
        project.background ? readLocalImage(project.background, 'background').then(a => { candidates.background = a; }) : Promise.resolve(),
      ]).then(results => { for (const result of results) if (result.status === 'rejected') throw result.reason; }) : Promise.resolve();
      const soundPromise = import('@/lib/media-audio').then(({ decodeMediaAudio }) => decodeMediaAudio(next, controller.signal)).then(buffer => prepareSound(buffer, controller.signal));
      const results = await Promise.allSettled([ready, soundPromise, assets]);
      for (const i of [0, 2]) if (results[i].status === 'rejected') throw (results[i] as PromiseRejectedResult).reason;
      const sound = results[1].status === 'fulfilled' ? results[1].value as PreparedSound : null;
      if (request !== mediaLoadRef.current || controller.signal.aborted) return false;
      const length = Number.isFinite(element.duration) ? element.duration : sound?.audio?.duration ?? 0;
      if (!(length > 0)) throw new Error('Could not determine the media duration.');
      const context = audioContextRef.current ?? new AudioContext(); audioContextRef.current = context;
      const monitor = monitorRef.current ?? context.createGain();
      if (!monitorRef.current) { monitor.connect(context.destination); monitorRef.current = monitor; }
      monitor.gain.setValueAtTime(volumeRef.current, context.currentTime);
      const source = context.createMediaElementSource(element); source.connect(monitor);
      const liveSound = sound ? null : new LiveSound(context, source);
      mediaRef.current?.pause(); mediaRef.current?.remove(); sourceRef.current?.disconnect();
      liveSoundRef.current?.dispose(); liveSoundRef.current = liveSound;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      mediaHostRef.current?.appendChild(element); mediaRef.current = element; videoRef.current = video ? element as HTMLVideoElement : null;
      sourceRef.current = source; objectUrlRef.current = url; element.loop = loopRef.current;
      soundRef.current = sound; setPreparedSound(sound);
      featuresRef.current = sound?.audio ? new PcmFeatures(Array.from({ length: sound.audio.numberOfChannels }, (_, i) => sound.audio!.getChannelData(i)), sound.audio.sampleRate) : null;
      soundFrameRef.current = null; audioStateRef.current = createAudioReactiveState(); segmentEndRef.current = null; lastAudioRef.current = 0;
      setFile(next); setIsVideo(video); setPlaying(false); setPosition(0); setDuration(length);
      setRange(savedRange && savedRange[1] > savedRange[0]
        ? [Math.max(0, Math.min(savedRange[0], Math.max(0, length - .1))), Math.max(.1, Math.min(savedRange[1], length))] : [0, length]);
      if (project) {
        ++logoLoadRef.current; ++backgroundLoadRef.current;
        commitLogo(candidates.logo); commitBackground(candidates.background);
        setFormat(project.format); setResolution(project.resolution ?? 720); setFrameRate(project.frameRate ?? 30); setVideoCompression(project.videoCompression ?? false); resetSettings(project.settings); setSubtitles(project.subtitles); setActiveLook(null);
      } else {
        setSubtitles([]); resetSettings(current => ({ ...current, trackTitle: next.name.replace(/\.[^.]+$/, '').slice(0, 120), trackArtist: '' }));
      }
      element.onplay = () => { if (element === mediaRef.current) setPlaying(true); };
      element.onpause = () => { if (element === mediaRef.current) { setPlaying(false); liveSoundRef.current?.reset(); } };
      element.onended = () => { if (element === mediaRef.current) { setPlaying(false); segmentEndRef.current = null; } };
      element.onseeking = () => {
        if (element !== mediaRef.current) return;
        const time = Math.floor(element.currentTime * ANALYSIS_FPS) / ANALYSIS_FPS;
        const history = warmSoundResponse(sound?.envelopes ?? [], settingsRef.current, time);
        audioStateRef.current = history.state;
        const frame = featuresRef.current?.at(time);
        if (frame) soundResponse(frame, settingsRef.current, audioStateRef.current, (time - history.lastTime) * 1000);
        else soundFrameRef.current = null;
        liveSoundRef.current?.reset(); lastAudioRef.current = time;
      };
      element.onerror = () => { if (element === mediaRef.current) setError('Playback failed. Try another media file.'); };
      if (!sound) setNotice('Playback is ready with live sound response. Export support depends on the file and this browser; choose a short section for large files.');
      committed = true; return true;
    } catch (caught) {
      if (request === mediaLoadRef.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not open this media.');
      return false;
    } finally {
      if (!committed) {
        element.pause(); element.removeAttribute('src'); element.load(); URL.revokeObjectURL(url);
        if (candidates.logo) URL.revokeObjectURL(candidates.logo.url);
        if (candidates.background) URL.revokeObjectURL(candidates.background.url);
      }
      if (request === mediaLoadRef.current) { setLoadingMedia(false); mediaLoadAbortRef.current = null; }
    }
  }, [resetSettings]);

  const seek = useCallback((time: number) => {
    const element = mediaRef.current;
    if (!element || exportingRef.current) return;
    segmentEndRef.current = null;
    element.currentTime = Math.max(0, Math.min(durationRef.current, time));
    setPosition(element.currentTime);
  }, []);

  const togglePlay = async () => {
    const element = mediaRef.current;
    if (!element) { fileInputRef.current?.click(); return; }
    if (exportingRef.current) return;
    try {
      segmentEndRef.current = null;
      if (element.paused) {
        await audioContextRef.current?.resume();
        if (element.ended) element.currentTime = 0;
        await element.play();
      } else element.pause();
    } catch { setError("Playback was blocked. Press play again or try another file."); }
  };
  const previewRange = async () => {
    const element = mediaRef.current;
    if (!element) return;
    try {
      element.pause(); element.currentTime = range[0];
      audioStateRef.current = createAudioReactiveState();
      segmentEndRef.current = range[1];
      await audioContextRef.current?.resume();
      await element.play();
      setExportOpen(false);
    } catch { setError("Could not preview that section."); }
  };
  const exportImage = () => {
    const target = dimensions[format];
    const imageCanvas = document.createElement("canvas");
    imageCanvas.width = target.width; imageCanvas.height = target.height;
    const context = imageCanvas.getContext("2d", { alpha: false });
    if (!context) { setError("Could not create the image."); return; }
    drawVisualization(context, settings, frequencyRef.current, waveRef.current, particleRef.current,
      frameTimeRef.current, 0, videoRef.current, logoRef.current, audioStateRef.current,
      soundFrameRef.current?.sampleRate ?? 48000, duration, subtitles,
      { sound: soundFrameRef.current, background: backgroundRef.current, drop: dropRef.current, reducedMotion: reducedMotionRef.current });
    imageCanvas.toBlob(blob => {
      if (!blob) { setError("Could not create the image."); return; }
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `pulseframe-${settings.mode}-${dimensions[format].label.replace(":", "x")}.png`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice("Frame saved as PNG.");
    }, "image/png");
  };
  const exportVideo = async () => {
    if (!file || !duration || exportingRef.current) return;
    mediaRef.current?.pause(); segmentEndRef.current = null;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    exportingRef.current = true; setExporting(true);
    setProgress({ phase: "Preparing media", percent: 0 }); setError(""); setNotice("");
    try {
      const { exportVisualVideo } = await import("@/lib/export-video");
      const output = exportDimensions(format, resolution);
      const { blob, extension } = await exportVisualVideo({
        file, start: range[0], end: range[1],
        width: output.width, height: output.height, duration, videoCompression, frameRate,
        settings: structuredClone(settings), subtitles: subtitles.map(cue => ({ ...cue })),
        logo: logoRef.current, background: backgroundRef.current, prepared: soundRef.current ?? undefined,
        reducedMotion: reducedMotionRef.current, signal: controller.signal, onProgress: setProgress,
      });
      if (controller.signal.aborted) return;
      const filename = `${file.name.replace(/\.[^.]+$/, "")}-pulseframe-${Math.floor(range[0])}-${Math.ceil(range[1])}.${extension}`;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice(`Export complete: ${extension.toUpperCase()} video at ${resolution}p with ${timestamp(range[1] - range[0])} of media.${videoCompression ? " Video compression enabled." : ""}`);
      setExportOpen(false);
    } catch (caught) {
      if (controller.signal.aborted) setNotice("Export canceled.");
      else setError(caught instanceof Error ? caught.message : "Could not export this file.");
    } finally {
      exportingRef.current = false; exportAbortRef.current = null;
      setExporting(false); setProgress(null);
    }
  };

  const saveProject = () => {
    if (!file || exportingRef.current) return;
    try {
      const blob = makeProjectFile({ media: file, logo: logoFileRef.current, background: backgroundFileRef.current,
        settings, subtitles, format, resolution, frameRate, videoCompression, range });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${file.name.replace(/\.[^.]+$/, "")}-pulseframe.pulseframe`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setProjectOpen(false); setNotice("Project file saved with your media and edits.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save project."); }
  };
  const openProject = async (projectFile: File | undefined) => {
    if (!projectFile || exportingRef.current || openingProject) return;
    setOpeningProject(true); setError("");
    const currentLoad = mediaLoadRef.current;
    try {
      const project = await readProjectFile(projectFile);
      if (currentLoad !== mediaLoadRef.current) return;
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
        event.preventDefault(); seek((mediaRef.current?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 5 : -5));
      }
    };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  }, [customizerOpen, exportOpen, subtitleOpen, projectOpen, presetOpen, lookSaveOpen, helpOpen, exporting, loadingMedia, focusView, seek]);
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
          <button className="icon-text-button" onClick={exportImage} title="Save current frame"><ImageDown size={16}/><span>Save frame</span></button>
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
      onCancel={() => exportAbortRef.current?.abort()} onPreview={previewRange}/>
    <SubtitleDialog open={subtitleOpen} onOpenChange={setSubtitleOpen} cues={subtitles} onChange={setSubtitles}
      position={position} duration={duration} onSeek={time => {
        if (mediaRef.current) { mediaRef.current.pause(); mediaRef.current.currentTime = time; setPosition(time); audioStateRef.current = createAudioReactiveState(); }
      }}/>
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
