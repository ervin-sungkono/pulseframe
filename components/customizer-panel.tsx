"use client";
/* eslint-disable @next/next/no-img-element -- Local logo and background previews use blob URLs. */

import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import { Check, ChevronDown, ImagePlus, RotateCcw, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_SETTINGS, palettes, type CustomizerSection } from "@/lib/customizer-config";
import { DEFAULT_LOGO_AUTO_FIT, DEFAULT_LOGO_FIT_SCALE, DEFAULT_LOGO_PLACEMENTS, type VisualMode, type ParticleMode, type VisualSettings, type BackdropMode, type LogoPlacement, type ParticleFlow, type ResponseStyle } from "@/lib/visualizer";

export { DEFAULT_SETTINGS };

const modes: { id: VisualMode; name: string; description: string }[] = [
  { id: "ring", name: "Pulse Ring", description: "Layered solid waves" },
  { id: "spectrum", name: "Spectrum", description: "Bars with a soft reflection" },
  { id: "edges", name: "Edge Bars", description: "Opposite frequency directions" },
];
const particleModes: ParticleMode[] = ["stardust", "sparks", "constellation", "comets"];
const backdrops: { id: BackdropMode; label: string }[] = [
  { id: "nebula", label: "Nebula" }, { id: "grid", label: "Grid" }, { id: "clean", label: "Clean" },
];
const CustomizerDisabledContext = createContext(false);

function SettingSlider({ label, value, display, min, max, step = 1, onChange, disabled = false, inputScale = 1 }: {
  label: string; value: number; display: string; min: number; max: number; step?: number;
  onChange: (value: number) => void; disabled?: boolean; inputScale?: number;
}) {
  const panelDisabled = useContext(CustomizerDisabledContext);
  const [numberDraft, setNumberDraft] = useState("");
  const [numberFocused, setNumberFocused] = useState(false);
  const actualDisabled = disabled || panelDisabled;
  const scaled = (number: number) => Number((number * inputScale).toFixed(6));
  const inputMin = scaled(min);
  const inputMax = scaled(max);
  const inputStep = scaled(step);
  const updateNumber = (next: number) => {
    if (!Number.isFinite(next)) return;
    const raw = next / inputScale;
    const normalized = step === 1 && Number.isInteger(min) && Number.isInteger(max) ? Math.round(raw) : raw;
    onChange(Math.min(max, Math.max(min, normalized)));
  };
  return <div className={`setting-slider ${actualDisabled ? "setting-slider-disabled" : ""}`}>
    <div className="setting-line"><span>{label}</span><output>{display}</output></div>
    <div className="setting-control-row">
      <Slider aria-label={label} className="studio-slider" value={[value]} min={min} max={max} step={step}
        disabled={actualDisabled} onValueChange={values => updateNumber(values[0] * inputScale)} />
      <input className="setting-number" type="number" aria-label={`${label} value`} value={numberFocused ? numberDraft : scaled(value)}
        min={inputMin} max={inputMax} step={inputStep} disabled={actualDisabled}
        onFocus={() => { setNumberDraft(String(scaled(value))); setNumberFocused(true); }}
        onChange={event => {
          setNumberDraft(event.currentTarget.value);
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next) && next >= inputMin && next <= inputMax) updateNumber(next);
        }}
        onBlur={event => { if (event.currentTarget.value !== "") updateNumber(event.currentTarget.valueAsNumber); setNumberFocused(false); }}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </div>
  </div>;
}

function PanelSwitch(props: ComponentProps<typeof Switch>) {
  const panelDisabled = useContext(CustomizerDisabledContext);
  return <Switch {...props} disabled={props.disabled || panelDisabled}/>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const displayedValue = focused ? draft : value;
  const valid = /^#[\da-f]{6}$/i.test(displayedValue);

  const edit = (next: string) => {
    setDraft(next);
    if (/^#[\da-f]{6}$/i.test(next)) onChange(next.toLowerCase());
  };

  return <label className="custom-color-control">
    <span>{label}</span>
    <div className="custom-color-inputs">
      <input aria-label={`${label} color`} type="color" value={value} onChange={event => {
        setDraft(event.currentTarget.value);
        onChange(event.currentTarget.value);
      }}/>
      <input aria-label={`${label} HEX`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
        maxLength={7} pattern="^#[\da-fA-F]{6}$" placeholder="#aabbcc" value={displayedValue}
        aria-invalid={!valid} onFocus={() => {
          setDraft(value);
          setFocused(true);
        }} onBlur={() => setFocused(false)} onChange={event => edit(event.currentTarget.value)}/>
    </div>
  </label>;
}

function ControlSection({ number, title, section, onResetSection, initiallyOpen = false, children }: {
  number: string; title: string; section: CustomizerSection; onResetSection: (section: CustomizerSection) => void;
  initiallyOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <section className="control-section customizer-section">
    <details className="customizer-disclosure" open={open} onToggle={event => {
      const next = event.currentTarget.open;
      setOpen(current => current === next ? current : next);
    }}>
      <summary className="control-title">
        <span>{number}</span><h3>{title}</h3><ChevronDown className="section-chevron" size={16} aria-hidden="true"/>
      </summary>
      <div className="section-controls">{children}</div>
    </details>
    <button type="button" className="section-reset" aria-label={`Reset ${title.toLowerCase()} settings`}
      onClick={() => onResetSection(section)}><RotateCcw size={12}/> Reset</button>
  </section>;
}

export type CustomizerPanelProps = {
  settings: VisualSettings;
  quickLooks?: ReactNode;
  disabled?: boolean;
  onPatch: (changes: Partial<VisualSettings>) => void;
  onResetSection: (section: CustomizerSection) => void;
  /** Compatibility callback for callers that still update one setting at a time. */
  onChange?: <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => void;
  /** Compatibility callback for callers that apply multi-setting quick looks. */
  onApplyLook?: (changes: Partial<VisualSettings>) => void;
  isVideo: boolean;
  onReset: () => void;
  logoName: string | null;
  logoUrl: string | null;
  onLogoFile: (file: File | null) => void;
  backgroundName: string | null;
  backgroundUrl: string | null;
  onBackgroundFile: (file: File | null) => void;
};

export function CustomizerPanel({ settings, quickLooks, disabled = false, onPatch, onResetSection, onChange, onApplyLook, isVideo, onReset, logoName, logoUrl, onLogoFile, backgroundName, backgroundUrl, onBackgroundFile }: CustomizerPanelProps) {
  const palette = palettes.find(item => item.primary === settings.primary && item.secondary === settings.secondary && item.background === settings.background);
  const placement = settings.logoPlacements[settings.mode];
  const fitTarget = settings.mode === "ring" ? "inner circle" : settings.mode === "edges" ? "center frame" : "upper frame";
  const change = <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => {
    if (disabled) return;
    if (onChange) onChange(key, value);
    else onPatch({ [key]: value } as Partial<VisualSettings>);
  };
  const applyChanges = (changes: Partial<VisualSettings>) => {
    if (disabled) return;
    if (onApplyLook) onApplyLook(changes);
    else onPatch(changes);
  };
  const patch = (changes: Partial<VisualSettings>) => {
    if (!disabled) onPatch(changes);
  };
  const updatePlacement = (key: keyof LogoPlacement, value: number) =>
    change("logoPlacements", { ...settings.logoPlacements, [settings.mode]: { ...placement, [key]: value } });

  return <CustomizerDisabledContext.Provider value={disabled}><fieldset className="customizer-fieldset" disabled={disabled} aria-busy={disabled}>
    <div className="panel-scroll">
      {quickLooks && <div className="customizer-quicklooks">{quickLooks}</div>}

      <ControlSection number="01" title="Visual" section="visual" initiallyOpen onResetSection={onResetSection}>
        <h4 className="control-subtitle">Visual style</h4>
        <div className="mode-grid">{modes.map(mode => <button type="button" key={mode.id} className={`mode-card ${settings.mode === mode.id ? "selected" : ""}`}
          onClick={() => change("mode", mode.id)} aria-pressed={settings.mode === mode.id}>
          <span className={`mode-glyph ${mode.id}`} aria-hidden="true"><i/><i/><i/><i/><i/></span>
          <strong>{mode.name}</strong><small>{mode.description}</small>
        </button>)}</div>
        {settings.mode === "ring" && <div className="style-options">
          <div className="setting-choice"><span>Wave focus</span><div className="pill-group" role="group" aria-label="Pulse Ring wave focus">
            {([['full', 'Full sound'], ['bass', 'Bass waves'], ['auto', 'Auto']] as const).map(([id, label]) => <button type="button" key={id} className={settings.ringFocus === id ? "active" : ""}
              aria-pressed={settings.ringFocus === id} onClick={() => change("ringFocus", id)}>{label}</button>)}
          </div></div>
          <p className="setting-hint">Full sound follows bass, vocals, and treble. Bass waves focuses on low frequencies. Auto adapts between them.</p>
          <div className="setting-choice"><span>Wave layers</span><div className="pill-group" role="group" aria-label="Pulse Ring wave layers">
            {[1, 2, 3, 4].map(count => <button type="button" key={count} className={settings.ringLayers === count ? "active" : ""}
              aria-pressed={settings.ringLayers === count} onClick={() => change("ringLayers", count)}>{count}</button>)}
          </div></div>
          {settings.ringLayers > 1 && <SettingSlider label="Rear layer opacity" value={settings.ringRearOpacity} display={`${settings.ringRearOpacity}%`}
            min={0} max={100} step={5} onChange={value => change("ringRearOpacity", value)}/>}
          <div className="toggle-line"><div><strong>Mirrored waves</strong><span>Match the wave shape on both sides</span></div>
            <PanelSwitch checked={settings.ringMirror} onCheckedChange={value => change("ringMirror", value)} aria-label="Mirrored Pulse Ring waves"/></div>
        </div>}
        {settings.mode !== "ring" && <div className="style-options">
          <SettingSlider label="Bar roundness" value={settings.spectrumRoundness} display={`${settings.spectrumRoundness}%`}
            min={0} max={100} step={5} onChange={value => change("spectrumRoundness", value)}/>
          {settings.mode === "spectrum" ? <SettingSlider label="Reflection opacity" value={settings.spectrumReflection} display={`${settings.spectrumReflection}%`}
            min={0} max={100} step={5} onChange={value => change("spectrumReflection", value)}/>
            : <p className="setting-hint">Top: bass to treble. Bottom: treble to bass. Both grow inward from the frame edges.</p>}
        </div>}
        <SettingSlider label="Visual size" value={settings.visualScale} display={`${Math.round(settings.visualScale * 100)}%`}
          min={.5} max={1.5} step={.05} inputScale={100} onChange={value => change("visualScale", value)}/>
      </ControlSection>

      <ControlSection number="02" title="Colors & background" section="colors" initiallyOpen onResetSection={onResetSection}>
        <h4 className="control-subtitle">Color palette</h4>
        <div className="palette-list">{palettes.map(item => {
          const selected = palette?.name === item.name;
          return <button type="button" key={item.name} className={`palette-option ${selected ? "selected" : ""}`}
            onClick={() => applyChanges({ primary: item.primary, secondary: item.secondary, background: item.background })}
            aria-pressed={selected}>
            <span className="palette-dots"><i style={{ background: item.primary }}/><i style={{ background: item.secondary }}/><i style={{ background: item.background }}/></span>
            <span>{item.name}</span>{selected && <Check size={15}/>}
          </button>;
        })}</div>
        <details className="advanced-colors"><summary>Custom colors</summary><div className="custom-colors color-editor-grid">
          <ColorField label="Primary" value={settings.primary} onChange={value => change("primary", value)}/>
          <ColorField label="Accent" value={settings.secondary} onChange={value => change("secondary", value)}/>
          <ColorField label="Background" value={settings.background} onChange={value => change("background", value)}/>
        </div></details>
        <div className="setting-choice"><span>Atmosphere</span><div className="pill-group" role="group" aria-label="Background atmosphere">{backdrops.map(item =>
          <button type="button" key={item.id} className={settings.backdrop === item.id ? "active" : ""} aria-pressed={settings.backdrop === item.id}
            onClick={() => change("backdrop", item.id)}>{item.label}</button>)}</div></div>
        {settings.backdrop !== "clean" ? <SettingSlider label="Atmosphere strength" value={settings.atmosphere} display={`${Math.round(settings.atmosphere * 100)}%`}
          min={0} max={2} step={.1} inputScale={100} onChange={value => change("atmosphere", value)}/>
          : <p className="setting-hint">Clean removes the atmosphere layer. Strength applies to Nebula and Grid.</p>}
        <div className="background-image-controls">
          <h4 className="control-subtitle">Background image</h4>
          <p className="control-hint">Fill the frame with your image. It stays sharp between drop accents.</p>
          <div className="logo-row">
            {backgroundUrl ? <img src={backgroundUrl} alt="Current background" className="logo-thumbnail"/> : <span className="logo-placeholder"><ImagePlus size={20}/></span>}
            <div className="logo-copy"><strong>{backgroundName ?? "No image added"}</strong><span>PNG, JPEG, WebP, or AVIF · up to 20 MB</span></div>
          </div>
          <div className="logo-actions">
            <label className="logo-upload"><ImagePlus size={15}/>{backgroundName ? "Change image" : "Add image"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" disabled={disabled} onChange={event => {
                const chosen = event.currentTarget.files?.[0]; if (chosen) onBackgroundFile(chosen); event.currentTarget.value = "";
              }}/></label>
            {backgroundName && <button type="button" className="logo-remove" onClick={() => onBackgroundFile(null)}><X size={15}/> Remove</button>}
          </div>
          {backgroundName && <SettingSlider label="Image opacity" value={settings.backgroundOpacity} display={`${settings.backgroundOpacity}%`}
            min={0} max={100} onChange={value => change("backgroundOpacity", value)}/>}
          {isVideo && !backgroundName && <>
            <p className="setting-hint">An image replaces the source video backdrop. Remove it to show the video again.</p>
            <SettingSlider label="Video visibility" value={settings.videoOpacity} display={`${settings.videoOpacity}%`}
              min={0} max={100} onChange={value => change("videoOpacity", value)}/>
          </>}
        </div>
      </ControlSection>

      <ControlSection number="03" title="Motion & effects" section="motion" onResetSection={onResetSection}>
        <SettingSlider label="Motion speed" value={settings.motionSpeed} display={`${Math.round(settings.motionSpeed * 100)}%`}
          min={.1} max={3} step={.05} inputScale={100} onChange={value => change("motionSpeed", value)}/>
        <div className="toggle-line border-top"><div><strong>Enable particles</strong><span>Moving audio reactive field</span></div>
        <PanelSwitch checked={settings.particles} onCheckedChange={value => change("particles", value)} aria-label="Enable particles"/></div>
        <div className={`particle-options ${!settings.particles ? "disabled" : ""}`}>
          <div className="pill-group particle-mode-group" role="group" aria-label="Particle effect">{particleModes.map(mode => <button type="button" key={mode}
            className={settings.particleMode === mode ? "active" : ""}
            onClick={() => change("particleMode", mode)} disabled={!settings.particles} aria-pressed={settings.particleMode === mode}>
            {mode[0].toUpperCase() + mode.slice(1)}
          </button>)}</div>
          <div className="setting-choice"><span>Particle movement</span><div className="pill-group" role="group" aria-label="Particle movement">
            {([ ["drift", "Float"], ["rise", "Rise"], ["orbit", "Orbit"] ] as [ParticleFlow, string][]).map(([id, label]) =>
              <button type="button" key={id} className={settings.particleFlow === id ? "active" : ""} aria-pressed={settings.particleFlow === id}
                disabled={!settings.particles} onClick={() => change("particleFlow", id)}>{label}</button>)}</div></div>
          <SettingSlider label="Particle density" value={settings.particleCount} display={String(settings.particleCount)}
            min={0} max={300} disabled={!settings.particles} onChange={value => change("particleCount", value)}/>
          <SettingSlider label="Particle size" value={settings.particleSize} display={`${Math.round(settings.particleSize * 100)}%`}
            min={.25} max={3} step={.05} inputScale={100} disabled={!settings.particles} onChange={value => change("particleSize", value)}/>
        </div>
        <div className="toggle-line border-top"><div><strong>Orbit accents</strong><span>Rotating arcs around the visual</span></div>
          <PanelSwitch checked={settings.trails} onCheckedChange={value => change("trails", value)} aria-label="Orbit accents"/></div>
        <div className="toggle-line border-top"><div><strong>Beat lighting</strong><span>Choose how the frame lights up with each beat</span></div>
          <PanelSwitch checked={settings.beatRays} onCheckedChange={value => change("beatRays", value)} aria-label="Beat lighting"/></div>
        {settings.beatRays && <div className="lighting-options">
          <div className="pill-group lighting-mode-group" role="group" aria-label="Beat lighting style">
            {([ ["rays", "Rays"], ["aura", "Aura"], ["beams", "Spotlights"], ["edges", "Edge glow"] ] as const).map(([id, label]) =>
              <button type="button" key={id} className={settings.beatLighting === id ? "active" : ""} aria-pressed={settings.beatLighting === id}
                onClick={() => change("beatLighting", id)}>{label}</button>)}
          </div>
          <SettingSlider label="Lighting intensity" value={settings.beatLightingIntensity} display={`${settings.beatLightingIntensity}%`}
            min={0} max={100} step={5} onChange={value => change("beatLightingIntensity", value)}/>
        </div>}
        <div className="toggle-line border-top"><div><strong>Glitch effect</strong><span>Brief sound-reactive tears and color offsets</span></div>
          <PanelSwitch checked={settings.glitch} onCheckedChange={value => change("glitch", value)} aria-label="Glitch effect"/></div>
        {settings.glitch && <SettingSlider label="Glitch strength" value={settings.glitchStrength} display={`${Math.round(settings.glitchStrength * 100)}%`}
          min={.1} max={1} step={.05} inputScale={100} onChange={value => change("glitchStrength", value)}/>}
        <SettingSlider label="Glow intensity" value={settings.glow} display={`${Math.round(settings.glow * 100)}%`}
          min={0} max={2.5} step={.05} inputScale={100} onChange={value => change("glow", value)}/>
      </ControlSection>

      <ControlSection number="04" title="Audio response" section="audio" onResetSection={onResetSection}>
        <p className="control-hint">Choose how quickly the visual reacts. The quiet cutoff still keeps it calm in silence.</p>
        <div className="pill-group" role="group" aria-label="Response style">
          {([ ["smooth", "Smooth"], ["balanced", "Balanced"], ["punchy", "Punchy"] ] as [ResponseStyle, string][]).map(([id, label]) =>
            <button type="button" key={id} className={settings.responseStyle === id ? "active" : ""} aria-pressed={settings.responseStyle === id}
              onClick={() => change("responseStyle", id)}>{label}</button>)}
        </div>
        <SettingSlider label="Bass and kick emphasis" value={settings.bassBoost} display={`${Math.round(settings.bassBoost * 100)}%`}
          min={.2} max={3} step={.05} inputScale={100} onChange={value => change("bassBoost", value)}/>
        <SettingSlider label="Audio sensitivity" value={settings.sensitivity} display={`${Math.round(settings.sensitivity * 100)}%`}
          min={.2} max={3} step={.05} inputScale={100} onChange={value => change("sensitivity", value)}/>
        <SettingSlider label="Quiet audio cutoff" value={settings.quietThreshold} display={`${(settings.quietThreshold * 100).toFixed(1)}%`}
          min={0} max={.1} step={.002} inputScale={100} onChange={value => change("quietThreshold", value)}/>
        <p className="setting-hint">Filters soft audio response. The base visual stays visible during silence.</p>
        <div className="toggle-line border-top"><div><strong>Drop accents</strong><span>Brief glow and blur when bass returns after a quieter section. Detection is approximate.</span></div>
          <PanelSwitch checked={settings.dropEffects} onCheckedChange={value => change("dropEffects", value)} aria-label="Drop accents"/></div>
      </ControlSection>

      <ControlSection number="05" title="Logo" section="logo" onResetSection={onResetSection}>
        <h4 className="control-subtitle">Logo overlay</h4>
        <p className="control-hint">One logo, with a separate layout for each visual style.</p>
        <div className="logo-row">
          {logoUrl ? <img src={logoUrl} alt="Current logo" className="logo-thumbnail"/> : <span className="logo-placeholder"><ImagePlus size={20}/></span>}
          <div className="logo-copy"><strong>{logoName ?? "No logo added"}</strong><span>PNG, JPEG, or WebP · up to 8 MB</span></div>
        </div>
        <div className="logo-actions">
          <label className="logo-upload"><ImagePlus size={15}/>{logoName ? "Replace logo" : "Add logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => {
              const chosen = event.currentTarget.files?.[0];
              if (chosen) onLogoFile(chosen);
              event.currentTarget.value = "";
            }}/></label>
          {logoName && <button type="button" className="logo-remove" onClick={() => onLogoFile(null)}><X size={15}/> Remove</button>}
        </div>
        {logoName && <div className="logo-adjustments">
          <div className="logo-layout-heading"><strong>{modes.find(mode => mode.id === settings.mode)?.name} layout</strong>
            <button type="button" onClick={() => patch({
              logoAutoFit: { ...settings.logoAutoFit, [settings.mode]: DEFAULT_LOGO_AUTO_FIT[settings.mode] },
              logoFitScale: { ...settings.logoFitScale, [settings.mode]: DEFAULT_LOGO_FIT_SCALE[settings.mode] },
              logoPlacements: { ...settings.logoPlacements, [settings.mode]: { ...DEFAULT_LOGO_PLACEMENTS[settings.mode] } },
            })}>Reset this style</button></div>
          <div className="toggle-line logo-fit-line"><div><strong>Fit to {fitTarget}</strong><span>Fill the space and crop the excess</span></div>
          <PanelSwitch checked={settings.logoAutoFit[settings.mode]}
              onCheckedChange={value => change("logoAutoFit", { ...settings.logoAutoFit, [settings.mode]: value })}
              aria-label={`Automatically fit logo to ${fitTarget}`}/></div>
          {settings.logoAutoFit[settings.mode]
            ? <>
              <SettingSlider label="Image scale" value={settings.logoFitScale[settings.mode]} display={`${settings.logoFitScale[settings.mode]}%`}
                min={50} max={100} step={5} onChange={value => change("logoFitScale", { ...settings.logoFitScale, [settings.mode]: value })}/>
              <p className="setting-hint">100% fills the {fitTarget}. Lower the scale for a smaller image.</p>
            </>
            : <>
              <SettingSlider label="Logo size" value={placement.size} display={`${placement.size}%`}
                min={0} max={100} onChange={value => updatePlacement("size", value)}/>
              <SettingSlider label="Horizontal position" value={placement.x} display={`${placement.x}%`}
                min={0} max={100} onChange={value => updatePlacement("x", value)}/>
              <SettingSlider label="Vertical position" value={placement.y} display={`${placement.y}%`}
                min={0} max={100} onChange={value => updatePlacement("y", value)}/>
            </>}
          <SettingSlider label="Logo opacity" value={settings.logoOpacity} display={`${settings.logoOpacity}%`}
            min={0} max={100} onChange={value => change("logoOpacity", value)}/>
        </div>}
      </ControlSection>

      <ControlSection number="06" title="Track details" section="track" onResetSection={onResetSection}>
        <p className="control-hint">Optional text that appears in the preview, saved frame, and video.</p>
        <div className="toggle-line"><div><strong>Show title and artist</strong><span>Use the media filename as a starting title</span></div>
          <PanelSwitch checked={settings.showTrackInfo} onCheckedChange={value => change("showTrackInfo", value)} aria-label="Show title and artist"/></div>
        {settings.showTrackInfo && <div className="track-fields">
          <label>Title<input type="text" maxLength={120} placeholder="Song title" value={settings.trackTitle} onChange={event => change("trackTitle", event.currentTarget.value)}/></label>
          <label>Artist<input type="text" maxLength={120} placeholder="Artist name (optional)" value={settings.trackArtist} onChange={event => change("trackArtist", event.currentTarget.value)}/></label>
        </div>}
        <div className="toggle-line border-top track-timer-line"><div><strong>Show playback time</strong><span>Track time and total duration</span></div>
          <PanelSwitch checked={settings.showTimer} onCheckedChange={value => change("showTimer", value)} aria-label="Show playback time"/></div>
        {(settings.showTrackInfo || settings.showTimer) && <>
          <div className="setting-choice"><span>Placement</span><div className="pill-group" role="group" aria-label="Track details placement">
            {([ ["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"] ] as const).map(([id, label]) =>
              <button type="button" key={id} className={settings.infoPosition === id ? "active" : ""} aria-pressed={settings.infoPosition === id}
                onClick={() => change("infoPosition", id)}>{label}</button>)}</div></div>
          <div className="setting-choice"><span>Alignment</span><div className="pill-group" role="group" aria-label="Track details alignment">
            {([ ["left", "Left"], ["center", "Center"], ["right", "Right"] ] as const).map(([id, label]) =>
              <button type="button" key={id} className={settings.infoAlign === id ? "active" : ""} aria-pressed={settings.infoAlign === id}
                onClick={() => change("infoAlign", id)}>{label}</button>)}</div></div>
          <div className="setting-choice"><span>Overlay style</span><div className="pill-group lighting-mode-group" role="group" aria-label="Track overlay style">
            {([ ["shade", "Soft shade"], ["card", "Card"], ["accent", "Accent line"], ["plain", "Plain text"] ] as const).map(([id, label]) =>
              <button type="button" key={id} className={settings.infoStyle === id ? "active" : ""} aria-pressed={settings.infoStyle === id}
                onClick={() => change("infoStyle", id)}>{label}</button>)}
          </div></div>
          <SettingSlider label="Text size" value={settings.infoSize} display={`${Math.round(settings.infoSize * 100)}%`}
            min={.5} max={2} step={.05} inputScale={100} onChange={value => change("infoSize", value)}/>
          <details className="advanced-colors overlay-details"><summary>Typography & colors</summary>
            <div className="setting-choice"><span>Font</span><div className="pill-group" role="group" aria-label="Track font">
              {([ ["sans", "Modern"], ["serif", "Classic"], ["mono", "Mono"] ] as const).map(([id, label]) =>
                <button type="button" key={id} className={settings.infoFont === id ? "active" : ""} aria-pressed={settings.infoFont === id}
                  onClick={() => change("infoFont", id)}>{label}</button>)}
            </div></div>
            <div className="setting-choice"><span>Weight</span><div className="pill-group" role="group" aria-label="Track text weight">
              {([[500, "Regular"], [700, "Bold"]] as const).map(([id, label]) =>
                <button type="button" key={id} className={settings.infoWeight === id ? "active" : ""} aria-pressed={settings.infoWeight === id}
                  onClick={() => change("infoWeight", id)}>{label}</button>)}
            </div></div>
            <div className="custom-colors color-editor-grid">
              <ColorField label="Title" value={settings.infoColor} onChange={value => change("infoColor", value)}/>
              <ColorField label="Artist" value={settings.infoSecondaryColor} onChange={value => change("infoSecondaryColor", value)}/>
              <ColorField label="Background" value={settings.infoBackground} onChange={value => change("infoBackground", value)}/>
            </div>
            <SettingSlider label="Overlay opacity" value={settings.infoOpacity} display={`${settings.infoOpacity}%`}
              min={0} max={100} step={5} onChange={value => change("infoOpacity", value)}/>
            {settings.infoStyle !== "plain" && <SettingSlider label="Background opacity" value={settings.infoBackgroundOpacity} display={`${settings.infoBackgroundOpacity}%`}
              min={0} max={100} step={5} onChange={value => change("infoBackgroundOpacity", value)}/>}
            {settings.infoStyle === "card" && <SettingSlider label="Card corners" value={settings.infoRadius} display={`${Math.round(settings.infoRadius / 36 * 100)}%`}
              min={0} max={36} step={2} inputScale={100 / 36} onChange={value => change("infoRadius", value)}/>}
          </details>
        </>}
      </ControlSection>

      <button type="button" className="reset-button" onClick={onReset}><RotateCcw size={14}/> Reset appearance</button>
    </div>
  </fieldset></CustomizerDisabledContext.Provider>;
}
