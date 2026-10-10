import { useEffect, useRef } from "react";
import { DEFAULT_SETTINGS } from "@/lib/customizer-config";
import type { PresetStyle } from "@/lib/presets";
import { drawVisualization, makeParticles } from "@/lib/visualizer";

/** A bounded illustration drawn by the production renderer, without media or DSP. */
export function LookPreview({ settings }: { settings: PresetStyle }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    const frequency = new Uint8Array(2048);
    const waveform = new Uint8Array(4096);
    const particles = makeParticles(80);
    const look = {
      ...DEFAULT_SETTINGS,
      ...settings,
      trackTitle: "",
      trackArtist: "",
      showTrackInfo: false,
      showTimer: false,
      particleCount: Math.min(settings.particleCount, 80),
    };
    let visible = false;
    let hovered = false;
    let focused = false;
    let frame = 0;
    let last = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const draw = (time: number) => {
      for (let i = 0; i < frequency.length; i++)
        frequency[i] = Math.max(0, 170 - i * 0.28) * (0.65 + 0.35 * Math.sin(i * 0.03 + time * 2));
      for (let i = 0; i < waveform.length; i++) waveform[i] = 128 + Math.sin(i * 0.032 + time) * 35;
      drawVisualization(
        ctx,
        look,
        frequency,
        waveform,
        particles,
        time,
        1000 / 12,
        undefined,
        undefined,
        undefined,
        48000,
        0,
        [],
        { reducedMotion: reduced.matches },
      );
    };
    const tick = (now: number) => {
      if (!visible || !(hovered || focused) || reduced.matches || document.hidden) {
        frame = 0;
        return;
      }
      if (now - last >= 1000 / 12) {
        last = now;
        draw(now / 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      if (visible) draw(1.5);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (visible && (hovered || focused) && !reduced.matches && !document.hidden)
        frame = requestAnimationFrame(tick);
    };
    const parent = canvas.closest("button") ?? canvas.parentElement;
    const enter = () => {
      hovered = true;
      sync();
    };
    const leave = () => {
      hovered = false;
      sync();
    };
    const focus = () => {
      focused = true;
      sync();
    };
    const blur = () => {
      focused = false;
      sync();
    };
    parent?.addEventListener("mouseenter", enter);
    parent?.addEventListener("mouseleave", leave);
    parent?.addEventListener("focus", focus);
    parent?.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      parent?.removeEventListener("mouseenter", enter);
      parent?.removeEventListener("mouseleave", leave);
      parent?.removeEventListener("focus", focus);
      parent?.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
    };
  }, [settings]);
  return (
    <canvas ref={ref} width={320} height={180} className="look-render-preview" aria-hidden="true" />
  );
}
