"use client";
/* eslint-disable @next/next/no-img-element -- Logo preview uses a local blob URL. */

import type { CSSProperties } from "react";
import { Check, ImagePlus, RotateCcw, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_LOGO_AUTO_FIT, DEFAULT_LOGO_FIT_SCALE, DEFAULT_LOGO_PLACEMENTS, type VisualMode, type ParticleMode, type VisualSettings, type BackdropMode, type LogoPlacement, type ParticleFlow, type ResponseStyle } from "@/lib/visualizer";

const palettes = [
  { name: "Electric", primary: "#9b72ff", secondary: "#61e5ff", background: "#080c20" },
  { name: "Afterglow", primary: "#ff688e", secondary: "#ffbd6a", background: "#190c21" },
  { name: "Aqua", primary: "#36e7d2", secondary: "#79a8ff", background: "#061921" },
  { name: "Solar", primary: "#ffc85c", secondary: "#fc728a", background: "#1b1020" },
  { name: "Violet", primary: "#d875ff", secondary: "#83ffdd", background: "#110a24" },
  { name: "Monochrome", primary: "#e3e7ff", secondary: "#7e8bc0", background: "#070a13" },
];
export const DEFAULT_SETTINGS: VisualSettings = {
  mode: "ring", spectrumRoundness: 100, spectrumReflection: 45, ringLayers: 3, ringRearOpacity: 30, ringMirror: true, ringFocus: "full", particleMode: "stardust", particleFlow: "drift", primary: palettes[0].primary,
  secondary: palettes[0].secondary, background: palettes[0].background,
  backdrop: "nebula", sensitivity: 1.3, quietThreshold: .006, bassBoost: 1, responseStyle: "balanced", atmosphere: 1, particleCount: 120, glow: .95,
  visualScale: 1.1, motionSpeed: 1, particleSize: 1,
  trails: true, beatRays: true, beatLighting: "rays", beatLightingIntensity: 65, particles: true, videoOpacity: 55,
  backgroundOpacity: 25, dropEffects: true,
  glitch: false, glitchStrength: .35,
  logoOpacity: 100, logoAutoFit: DEFAULT_LOGO_AUTO_FIT, logoFitScale: DEFAULT_LOGO_FIT_SCALE, logoPlacements: DEFAULT_LOGO_PLACEMENTS,
  showTrackInfo: false, trackTitle: "", trackArtist: "", infoPosition: "top", infoAlign: "left", infoSize: 1, infoStyle: "shade", infoFont: "sans", infoWeight: 700, infoColor: "#ffffff", infoSecondaryColor: "#c8d0e5", infoOpacity: 100, infoBackground: "#040816", infoBackgroundOpacity: 55, infoRadius: 16, showTimer: false,
};
const modes: { id: VisualMode; name: string; description: string }[] = [
  { id: "ring", name: "Pulse Ring", description: "Layered solid waves" },
  { id: "spectrum", name: "Spectrum", description: "Bars with a soft reflection" },
  { id: "edges", name: "Edge Bars", description: "Opposite frequency directions" },
];
const particleModes: ParticleMode[] = ["stardust", "sparks", "constellation", "comets"];
const backdrops: { id: BackdropMode; label: string }[] = [
  { id: "nebula", label: "Nebula" }, { id: "grid", label: "Grid" }, { id: "clean", label: "Clean" },
];
type Look = { name: string; caption: string; mode: VisualMode; palette: number; backdrop: BackdropMode; particleMode: ParticleMode; trails: boolean; beatRays: boolean; beatLighting: VisualSettings["beatLighting"]; beatLightingIntensity: number; glow: number };
const looks: Look[] = [
  { name: "Contour", caption: "Layered pulse ring", mode: "ring", palette: 0, backdrop: "clean", particleMode: "stardust", trails: false, beatRays: true, beatLighting: "rays", beatLightingIntensity: 65, glow: .95 },
  { name: "Pulse", caption: "Electric waves", mode: "ring", palette: 0, backdrop: "nebula", particleMode: "stardust", trails: true, beatRays: true, beatLighting: "aura", beatLightingIntensity: 65, glow: .95 },
  { name: "After Hours", caption: "Neon bars", mode: "spectrum", palette: 1, backdrop: "grid", particleMode: "sparks", trails: false, beatRays: true, beatLighting: "beams", beatLightingIntensity: 65, glow: 1.2 },
  { name: "Tidal", caption: "Aqua waves", mode: "ring", palette: 2, backdrop: "nebula", particleMode: "constellation", trails: false, beatRays: false, beatLighting: "aura", beatLightingIntensity: 65, glow: 1.05 },
  { name: "Solar Flare", caption: "Warm pulse ring", mode: "ring", palette: 3, backdrop: "nebula", particleMode: "comets", trails: true, beatRays: true, beatLighting: "edges", beatLightingIntensity: 65, glow: 1.15 },
  { name: "Prism", caption: "Violet bars", mode: "spectrum", palette: 4, backdrop: "clean", particleMode: "sparks", trails: false, beatRays: false, beatLighting: "aura", beatLightingIntensity: 65, glow: 1.25 },
  { name: "Eclipse", caption: "Minimal bars", mode: "spectrum", palette: 5, backdrop: "clean", particleMode: "comets", trails: false, beatRays: true, beatLighting: "edges", beatLightingIntensity: 65, glow: .85 },
];

function SettingSlider({ label, value, display, min, max, step = 1, onChange }: {
  label: string; value: number; display: string; min: number; max: number; step?: number;
  onChange: (value: number) => void;
}) {
  return <div className="setting-slider">
    <div className="setting-line"><span>{label}</span><output>{display}</output></div>
    <Slider aria-label={label} className="studio-slider" value={[value]} min={min} max={max} step={step}
      onValueChange={values => onChange(values[0])} />
  </div>;
}

export function CustomizerPanel({ settings, onChange, onApplyLook, isVideo, onReset, logoName, logoUrl, onLogoFile, backgroundName, backgroundUrl, onBackgroundFile }: {
  settings: VisualSettings;
  onChange: <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => void;
  onApplyLook: (changes: Partial<VisualSettings>) => void;
  isVideo: boolean;
  onReset: () => void;
  logoName: string | null;
  logoUrl: string | null;
  onLogoFile: (file: File | null) => void;
  backgroundName: string | null;
  backgroundUrl: string | null;
  onBackgroundFile: (file: File | null) => void;
}) {
  const palette = palettes.find(item => item.primary === settings.primary && item.secondary === settings.secondary);
  const placement = settings.logoPlacements[settings.mode];
  const fitTarget = settings.mode === "ring" ? "inner circle" : settings.mode === "edges" ? "center frame" : "upper frame";
  const updatePlacement = (key: keyof LogoPlacement, value: number) =>
    onChange("logoPlacements", { ...settings.logoPlacements, [settings.mode]: { ...placement, [key]: value } });
  return <div className="panel-scroll">
    <div className="control-section looks-section">
      <div className="control-title"><span>01</span><h3>Quick looks</h3></div>
      <div className="look-strip" role="group" aria-label="Visual presets">{looks.map(look => {
        const colors = palettes[look.palette];
        const selected = settings.mode === look.mode && settings.primary === colors.primary && settings.secondary === colors.secondary &&
          settings.backdrop === look.backdrop && settings.particleMode === look.particleMode &&
          settings.trails === look.trails && settings.beatRays === look.beatRays &&
          (!look.beatRays || (settings.beatLighting === look.beatLighting && settings.beatLightingIntensity === look.beatLightingIntensity));
        return <button key={look.name} className={`look-card ${selected ? "selected" : ""}`}
          aria-pressed={selected} onClick={() => onApplyLook({ mode: look.mode, particleMode: look.particleMode,
            primary: colors.primary, secondary: colors.secondary, background: colors.background,
            backdrop: look.backdrop, trails: look.trails, beatRays: look.beatRays, beatLighting: look.beatLighting, beatLightingIntensity: look.beatLightingIntensity, glow: look.glow })}>
          <span className={`look-art ${look.mode}`} style={{ "--look-primary": colors.primary, "--look-secondary": colors.secondary, "--look-background": colors.background } as CSSProperties} aria-hidden="true"><i/></span>
          <strong>{look.name}</strong><small>{look.caption}</small>
        </button>;
      })}</div>
    </div>
    <div className="control-section">
      <div className="control-title"><span>02</span><h3>Visual style</h3></div>
      <div className="mode-grid">{modes.map(mode => <button key={mode.id} className={`mode-card ${settings.mode === mode.id ? "selected" : ""}`}
        onClick={() => onChange("mode", mode.id)} aria-pressed={settings.mode === mode.id}>
        <span className={`mode-glyph ${mode.id}`} aria-hidden="true"><i/><i/><i/><i/><i/></span>
        <strong>{mode.name}</strong><small>{mode.description}</small>
      </button>)}</div>
      {settings.mode === "ring" && <div className="style-options">
        <div className="setting-choice"><span>Wave focus</span><div className="pill-group" role="group" aria-label="Pulse Ring wave focus">
          {([['full', 'Full sound'], ['bass', 'Bass waves'], ['auto', 'Auto']] as const).map(([id, label]) => <button key={id} className={settings.ringFocus === id ? "active" : ""}
            aria-pressed={settings.ringFocus === id} onClick={() => onChange("ringFocus", id)}>{label}</button>)}
        </div></div>
        <p className="setting-hint">Full sound follows bass, vocals, and treble. Bass waves focuses on low frequencies. Auto adapts between them.</p>
        <div className="setting-choice"><span>Wave layers</span><div className="pill-group" role="group" aria-label="Pulse Ring wave layers">
          {[1, 2, 3, 4].map(count => <button key={count} className={settings.ringLayers === count ? "active" : ""}
            aria-pressed={settings.ringLayers === count} onClick={() => onChange("ringLayers", count)}>{count}</button>)}
        </div></div>
        {settings.ringLayers > 1 && <SettingSlider label="Rear layer opacity" value={settings.ringRearOpacity} display={`${settings.ringRearOpacity}%`}
          min={0} max={100} step={5} onChange={value => onChange("ringRearOpacity", value)}/>}
        <div className="toggle-line"><div><strong>Mirrored waves</strong><span>Match the wave shape on both sides</span></div>
          <Switch checked={settings.ringMirror} onCheckedChange={value => onChange("ringMirror", value)} aria-label="Mirrored Pulse Ring waves"/></div>
      </div>}
      {settings.mode !== "ring" && <div className="style-options">
        <SettingSlider label="Bar roundness" value={settings.spectrumRoundness} display={`${settings.spectrumRoundness}%`}
          min={0} max={100} step={5} onChange={value => onChange("spectrumRoundness", value)}/>
        {settings.mode === "spectrum" ? <SettingSlider label="Reflection opacity" value={settings.spectrumReflection} display={`${settings.spectrumReflection}%`}
          min={0} max={100} step={5} onChange={value => onChange("spectrumReflection", value)}/>
          : <p className="setting-hint">Top: bass to treble. Bottom: treble to bass. Both grow inward from the frame edges.</p>}
      </div>}
      <div className="setting-choice"><span>Atmosphere</span><div className="pill-group" role="group" aria-label="Background atmosphere">{backdrops.map(item =>
        <button key={item.id} className={settings.backdrop === item.id ? "active" : ""} aria-pressed={settings.backdrop === item.id}
          onClick={() => onChange("backdrop", item.id)}>{item.label}</button>)}</div></div>
      <SettingSlider label="Atmosphere strength" value={settings.atmosphere} display={`${Math.round(settings.atmosphere * 100)}%`}
        min={0} max={1.8} step={.1} onChange={value => onChange("atmosphere", value)}/>
    </div>
    <div className="control-section">
      <div className="control-title"><span>03</span><h3>Color palette</h3></div>
      <div className="palette-list">{palettes.map(item => <button key={item.name}
        className={`palette-option ${palette?.name === item.name ? "selected" : ""}`}
        onClick={() => onApplyLook({ primary: item.primary, secondary: item.secondary, background: item.background })}
        aria-pressed={palette?.name === item.name}>
        <span className="palette-dots"><i style={{background:item.primary}}/><i style={{background:item.secondary}}/><i style={{background:item.background}}/></span>
        <span>{item.name}</span>{palette?.name === item.name && <Check size={15}/>}
      </button>)}</div>
      <details className="advanced-colors"><summary>Custom colors</summary><div className="custom-colors">
        <label><input aria-label="Primary color" type="color" value={settings.primary} onChange={event => onChange("primary", event.target.value)}/><span>Primary</span></label>
        <label><input aria-label="Accent color" type="color" value={settings.secondary} onChange={event => onChange("secondary", event.target.value)}/><span>Accent</span></label>
        <label><input aria-label="Background color" type="color" value={settings.background} onChange={event => onChange("background", event.target.value)}/><span>Background</span></label>
      </div></details>
    </div>
    <div className="control-section">
      <div className="control-title"><span>04</span><h3>Background image</h3></div>
      <p className="control-hint">Fill the frame with your image. It stays sharp between drop accents.</p>
      <div className="logo-row">
        {backgroundUrl ? <img src={backgroundUrl} alt="Current background" className="logo-thumbnail"/> : <span className="logo-placeholder"><ImagePlus size={20}/></span>}
        <div className="logo-copy"><strong>{backgroundName ?? "No image added"}</strong><span>PNG, JPEG, WebP, or AVIF · up to 20 MB</span></div>
      </div>
      <div className="logo-actions">
        <label className="logo-upload"><ImagePlus size={15}/>{backgroundName ? "Change image" : "Add image"}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => {
            const chosen = event.target.files?.[0]; if (chosen) onBackgroundFile(chosen); event.target.value = "";
          }}/></label>
        {backgroundName && <button className="logo-remove" onClick={() => onBackgroundFile(null)}><X size={15}/> Remove</button>}
      </div>
      {backgroundName && <SettingSlider label="Image opacity" value={settings.backgroundOpacity} display={`${settings.backgroundOpacity}%`}
        min={0} max={100} onChange={value => onChange("backgroundOpacity", value)}/>}
      {isVideo && <p className="setting-hint">An image replaces the source video backdrop. Remove it to show the video again.</p>}
      <div className="toggle-line border-top"><div><strong>Drop accents</strong><span>Brief glow and blur when bass returns after a quieter section. Detection is approximate.</span></div>
        <Switch checked={settings.dropEffects} onCheckedChange={value => onChange("dropEffects", value)} aria-label="Drop accents"/></div>
    </div>
    <div className="control-section">
      <div className="control-title"><span>05</span><h3>Motion & effects</h3></div>
      <div className="toggle-line"><div><strong>Enable particles</strong><span>Moving audio reactive field</span></div>
        <Switch checked={settings.particles} onCheckedChange={value => onChange("particles", value)} aria-label="Enable particles" /></div>
      <div className={`particle-options ${!settings.particles ? "disabled" : ""}`}>
        <div className="pill-group particle-mode-group" role="group" aria-label="Particle effect">{particleModes.map(mode => <button key={mode}
          className={settings.particleMode === mode ? "active" : ""}
          onClick={() => onChange("particleMode", mode)} disabled={!settings.particles} aria-pressed={settings.particleMode === mode}>
          {mode[0].toUpperCase() + mode.slice(1)}
        </button>)}</div>
        <div className="setting-choice"><span>Particle movement</span><div className="pill-group" role="group" aria-label="Particle movement">
          {([ ["drift", "Float"], ["rise", "Rise"], ["orbit", "Orbit"] ] as [ParticleFlow, string][]).map(([id, label]) =>
            <button key={id} className={settings.particleFlow === id ? "active" : ""} aria-pressed={settings.particleFlow === id}
              onClick={() => onChange("particleFlow", id)}>{label}</button>)}</div></div>
        <SettingSlider label="Particle density" value={settings.particleCount} display={String(settings.particleCount)}
          min={20} max={260} onChange={value => onChange("particleCount", value)}/>
        <SettingSlider label="Particle size" value={settings.particleSize} display={`${Math.round(settings.particleSize * 100)}%`}
          min={.5} max={2} step={.05} onChange={value => onChange("particleSize", value)}/>
      </div>
      <div className="toggle-line border-top"><div><strong>Orbit accents</strong><span>Rotating arcs around the visual</span></div>
        <Switch checked={settings.trails} onCheckedChange={value => onChange("trails", value)} aria-label="Orbit accents"/></div>
      <div className="toggle-line border-top"><div><strong>Beat lighting</strong><span>Choose how the frame lights up with each beat</span></div>
        <Switch checked={settings.beatRays} onCheckedChange={value => onChange("beatRays", value)} aria-label="Beat lighting"/></div>
      {settings.beatRays && <div className="lighting-options">
        <div className="pill-group lighting-mode-group" role="group" aria-label="Beat lighting style">
          {([["rays", "Rays"], ["aura", "Aura"], ["beams", "Spotlights"], ["edges", "Edge glow"]] as const).map(([id, label]) =>
            <button key={id} className={settings.beatLighting === id ? "active" : ""} aria-pressed={settings.beatLighting === id}
              onClick={() => onChange("beatLighting", id)}>{label}</button>)}
        </div>
        <SettingSlider label="Lighting intensity" value={settings.beatLightingIntensity} display={`${settings.beatLightingIntensity}%`}
          min={0} max={100} step={5} onChange={value => onChange("beatLightingIntensity", value)}/>
      </div>}
      <div className="toggle-line border-top"><div><strong>Glitch effect</strong><span>Brief sound-reactive tears and color offsets</span></div>
        <Switch checked={settings.glitch} onCheckedChange={value => onChange("glitch", value)} aria-label="Glitch effect"/></div>
      {settings.glitch && <SettingSlider label="Glitch strength" value={settings.glitchStrength} display={`${Math.round(settings.glitchStrength * 100)}%`}
        min={.1} max={1} step={.05} onChange={value => onChange("glitchStrength", value)}/>}
    </div>
    <div className="control-section">
      <div className="control-title"><span>06</span><h3>Track details</h3></div>
      <p className="control-hint">Optional text that appears in the preview, saved frame, and video.</p>
      <div className="toggle-line"><div><strong>Show title and artist</strong><span>Use the media filename as a starting title</span></div>
        <Switch checked={settings.showTrackInfo} onCheckedChange={value => onChange("showTrackInfo", value)} aria-label="Show title and artist"/></div>
      {settings.showTrackInfo && <div className="track-fields">
        <label>Title<input type="text" maxLength={120} placeholder="Song title" value={settings.trackTitle} onChange={event => onChange("trackTitle", event.target.value)}/></label>
        <label>Artist<input type="text" maxLength={120} placeholder="Artist name (optional)" value={settings.trackArtist} onChange={event => onChange("trackArtist", event.target.value)}/></label>
      </div>}
      <div className="toggle-line border-top track-timer-line"><div><strong>Show playback time</strong><span>Track time and total duration</span></div>
        <Switch checked={settings.showTimer} onCheckedChange={value => onChange("showTimer", value)} aria-label="Show playback time"/></div>
      {(settings.showTrackInfo || settings.showTimer) && <>
        <div className="setting-choice"><span>Placement</span><div className="pill-group" role="group" aria-label="Track details placement">
          {([ ["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"] ] as const).map(([id, label]) =>
            <button key={id} className={settings.infoPosition === id ? "active" : ""} aria-pressed={settings.infoPosition === id}
              onClick={() => onChange("infoPosition", id)}>{label}</button>)}</div></div>
        <div className="setting-choice"><span>Alignment</span><div className="pill-group" role="group" aria-label="Track details alignment">
          {([ ["left", "Left"], ["center", "Center"], ["right", "Right"] ] as const).map(([id, label]) =>
            <button key={id} className={settings.infoAlign === id ? "active" : ""} aria-pressed={settings.infoAlign === id}
              onClick={() => onChange("infoAlign", id)}>{label}</button>)}</div></div>
        <div className="setting-choice"><span>Overlay style</span><div className="pill-group lighting-mode-group" role="group" aria-label="Track overlay style">
          {([["shade", "Soft shade"], ["card", "Card"], ["accent", "Accent line"], ["plain", "Plain text"]] as const).map(([id,label]) =>
            <button key={id} className={settings.infoStyle === id ? "active" : ""} aria-pressed={settings.infoStyle === id} onClick={() => onChange("infoStyle",id)}>{label}</button>)}
        </div></div>
        <SettingSlider label="Text size" value={settings.infoSize} display={`${Math.round(settings.infoSize * 100)}%`}
          min={.75} max={1.5} step={.05} onChange={value => onChange("infoSize", value)}/>
        <details className="advanced-colors overlay-details"><summary>Typography & colors</summary>
          <div className="setting-choice"><span>Font</span><div className="pill-group" role="group" aria-label="Track font">
            {([["sans", "Modern"], ["serif", "Classic"], ["mono", "Mono"]] as const).map(([id,label]) => <button key={id} className={settings.infoFont === id ? "active" : ""} aria-pressed={settings.infoFont === id} onClick={() => onChange("infoFont",id)}>{label}</button>)}
          </div></div>
          <div className="setting-choice"><span>Weight</span><div className="pill-group" role="group" aria-label="Track text weight">
            {([[500, "Regular"], [700, "Bold"]] as const).map(([id,label]) => <button key={id} className={settings.infoWeight === id ? "active" : ""} aria-pressed={settings.infoWeight === id} onClick={() => onChange("infoWeight",id)}>{label}</button>)}
          </div></div>
          <div className="custom-colors">
            <label><input aria-label="Title color" type="color" value={settings.infoColor} onChange={e => onChange("infoColor",e.target.value)}/><span>Title</span></label>
            <label><input aria-label="Artist color" type="color" value={settings.infoSecondaryColor} onChange={e => onChange("infoSecondaryColor",e.target.value)}/><span>Artist</span></label>
            <label><input aria-label="Overlay background color" type="color" value={settings.infoBackground} onChange={e => onChange("infoBackground",e.target.value)}/><span>Background</span></label>
          </div>
          <SettingSlider label="Overlay opacity" value={settings.infoOpacity} display={`${settings.infoOpacity}%`} min={0} max={100} step={5} onChange={value => onChange("infoOpacity",value)}/>
          {settings.infoStyle !== "plain" && <SettingSlider label="Background opacity" value={settings.infoBackgroundOpacity} display={`${settings.infoBackgroundOpacity}%`} min={0} max={100} step={5} onChange={value => onChange("infoBackgroundOpacity",value)}/>}
          {settings.infoStyle === "card" && <SettingSlider label="Card corners" value={settings.infoRadius} display={`${Math.round(settings.infoRadius / 36 * 100)}%`} min={0} max={36} step={2} onChange={value => onChange("infoRadius",value)}/>}
        </details>
      </>}
    </div>
    <div className="control-section">
      <div className="control-title"><span>07</span><h3>Logo overlay</h3></div>
      <p className="control-hint">One logo, with a separate layout for each visual style.</p>
      <div className="logo-row">
        {logoUrl ? <img src={logoUrl} alt="Current logo" className="logo-thumbnail"/> : <span className="logo-placeholder"><ImagePlus size={20}/></span>}
        <div className="logo-copy"><strong>{logoName ?? "No logo added"}</strong><span>PNG, JPEG, or WebP · up to 8 MB</span></div>
      </div>
      <div className="logo-actions">
        <label className="logo-upload"><ImagePlus size={15}/>{logoName ? "Replace logo" : "Add logo"}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
            const chosen = event.target.files?.[0];
            if (chosen) onLogoFile(chosen);
            event.target.value = "";
          }}/></label>
        {logoName && <button className="logo-remove" onClick={() => onLogoFile(null)}><X size={15}/> Remove</button>}
      </div>
      {logoName && <div className="logo-adjustments">
        <div className="logo-layout-heading"><strong>{modes.find(mode => mode.id === settings.mode)?.name} layout</strong>
          <button onClick={() => {
            onChange("logoAutoFit", { ...settings.logoAutoFit, [settings.mode]: true });
            onChange("logoFitScale", { ...settings.logoFitScale, [settings.mode]: 100 });
            onChange("logoPlacements", { ...settings.logoPlacements, [settings.mode]: { ...DEFAULT_LOGO_PLACEMENTS[settings.mode] } });
          }}>Reset this style</button></div>
        <div className="toggle-line logo-fit-line"><div><strong>Fit to {fitTarget}</strong><span>Fill the space and crop the excess</span></div>
          <Switch checked={settings.logoAutoFit[settings.mode]}
            onCheckedChange={value => onChange("logoAutoFit", { ...settings.logoAutoFit, [settings.mode]: value })}
            aria-label={`Automatically fit logo to ${fitTarget}`}/></div>
        {settings.logoAutoFit[settings.mode]
          ? <>
            <SettingSlider label="Image scale" value={settings.logoFitScale[settings.mode]} display={`${settings.logoFitScale[settings.mode]}%`}
              min={50} max={100} step={5} onChange={value => onChange("logoFitScale", { ...settings.logoFitScale, [settings.mode]: value })}/>
            <p className="setting-hint">100% fills the {fitTarget}. Lower the scale for a smaller image.</p>
          </>
          : <>
            <SettingSlider label="Logo size" value={placement.size} display={`${placement.size}%`}
              min={8} max={42} onChange={value => updatePlacement("size", value)}/>
            <SettingSlider label="Horizontal position" value={placement.x} display={`${placement.x}%`}
              min={10} max={90} onChange={value => updatePlacement("x", value)}/>
            <SettingSlider label="Vertical position" value={placement.y} display={`${placement.y}%`}
              min={10} max={90} onChange={value => updatePlacement("y", value)}/>
          </>}
        <SettingSlider label="Logo opacity" value={settings.logoOpacity} display={`${settings.logoOpacity}%`}
          min={10} max={100} onChange={value => onChange("logoOpacity", value)}/>
      </div>}
    </div>
    <div className="control-section">
      <div className="control-title"><span>08</span><h3>Sound response</h3></div>
      <p className="control-hint">Choose how quickly the visual reacts. The quiet cutoff still keeps it calm in silence.</p>
      <div className="pill-group" role="group" aria-label="Response style">
        {([ ["smooth", "Smooth"], ["balanced", "Balanced"], ["punchy", "Punchy"] ] as [ResponseStyle, string][]).map(([id, label]) =>
          <button key={id} className={settings.responseStyle === id ? "active" : ""} aria-pressed={settings.responseStyle === id}
            onClick={() => onChange("responseStyle", id)}>{label}</button>)}
      </div>
      <SettingSlider label="Bass and kick emphasis" value={settings.bassBoost} display={`${Math.round(settings.bassBoost * 100)}%`}
        min={.5} max={2} step={.05} onChange={value => onChange("bassBoost", value)}/>
      <details className="advanced-tuning"><summary>More adjustments</summary>
      <SettingSlider label="Visual size" value={settings.visualScale} display={`${Math.round(settings.visualScale * 100)}%`}
        min={.7} max={1.35} step={.05} onChange={value => onChange("visualScale", value)}/>
      <SettingSlider label="Motion speed" value={settings.motionSpeed} display={`${Math.round(settings.motionSpeed * 100)}%`}
        min={.25} max={2} step={.05} onChange={value => onChange("motionSpeed", value)}/>
      <SettingSlider label="Audio sensitivity" value={settings.sensitivity} display={`${Math.round(settings.sensitivity * 100)}%`}
        min={.5} max={2.5} step={.05} onChange={value => onChange("sensitivity", value)}/>
      <SettingSlider label="Quiet audio cutoff" value={settings.quietThreshold} display={`${(settings.quietThreshold * 100).toFixed(1)}%`}
        min={0} max={.03} step={.002} onChange={value => onChange("quietThreshold", value)}/>
      <p className="setting-hint">Filters soft audio response. The base visual stays visible during silence.</p>
      <SettingSlider label="Glow intensity" value={settings.glow} display={`${Math.round(settings.glow * 100)}%`}
        min={0} max={2} step={.05} onChange={value => onChange("glow", value)}/>
      {isVideo && <SettingSlider label="Video visibility" value={settings.videoOpacity} display={`${settings.videoOpacity}%`}
        min={0} max={100} onChange={value => onChange("videoOpacity", value)}/>}
      </details>
    </div>
    <button className="reset-button" onClick={onReset}><RotateCcw size={14}/> Reset all settings</button>
  </div>;
}
