"use client";
import { useEffect, useRef } from "react";
import type { PreparedSound } from "@/lib/audio-features";
export function TrackWaveform({
  overview,
  position,
  duration,
  audioDuration,
  onSeek,
  disabled,
}: {
  overview: PreparedSound["overview"];
  position: number;
  duration: number;
  audioDuration: number;
  onSeek: (time: number) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const width = canvas.clientWidth,
        height = canvas.clientHeight,
        ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext("2d");
      if (!ctx || !width) return;
      ctx.scale(ratio, ratio);
      ctx.strokeStyle = "#a18ad4";
      ctx.lineWidth = 1.25;
      const count = overview[0]?.min.length ?? 0;
      for (let x = 0; x < width; x += 2) {
        const scale = duration / Math.max(0.001, audioDuration);
        const from = Math.floor((x / width) * count * scale),
          to = Math.max(from + 1, Math.ceil(((x + 2) / width) * count * scale));
        let lo = 0,
          hi = 0;
        for (const channel of overview)
          for (let i = from; i < Math.min(count, to); i++) {
            if (Number.isFinite(channel.min[i])) lo = Math.min(lo, channel.min[i]);
            if (Number.isFinite(channel.max[i])) hi = Math.max(hi, channel.max[i]);
          }
        ctx.beginPath();
        ctx.moveTo(x, height / 2 - Math.max(1, hi * height * 0.46));
        ctx.lineTo(x, height / 2 - Math.min(-1, lo * height * 0.46));
        ctx.stroke();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [overview, duration, audioDuration]);
  return (
    <div
      className={`track-waveform ${disabled ? "disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Seek in track waveform"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={position}
      aria-valuetext={`${Math.floor(position / 60)} minutes ${Math.floor(position % 60)} seconds`}
      aria-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) return;
        const box = event.currentTarget.getBoundingClientRect();
        onSeek(
          Math.max(0, Math.min(duration, ((event.clientX - box.left) / box.width) * duration)),
        );
      }}
      onKeyDown={(event) => {
        if (disabled || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        onSeek(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? duration
              : Math.max(0, Math.min(duration, position + (event.key === "ArrowRight" ? 5 : -5))),
        );
      }}
    >
      <canvas ref={ref} aria-hidden="true" />
      <span
        className="waveform-playhead"
        style={{ left: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }}
        aria-hidden="true"
      />
    </div>
  );
}
