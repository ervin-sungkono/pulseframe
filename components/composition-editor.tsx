"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import {
  clampCompositionBounds,
  compositionAspect,
  hitTestComposition,
  pixelsToBounds,
  pointerToCanvas,
  setCompositionBounds,
  type CompositionElement,
  type CompositionAspect,
  type PixelBounds,
} from "@/lib/composition";
import type { SubtitleCue } from "@/lib/subtitles";
import {
  visualizationCompositionGeometry,
  type LogoLayer,
  type VisualizationCompositionGeometry,
} from "@/lib/visualizer";
import type { VisualSettings } from "@/lib/visual-settings-model";

type ResizeCorner = "nw" | "ne" | "sw" | "se";
type SnapGuides = { x: number[]; y: number[] };
type Gesture = {
  pointerId: number;
  element: CompositionElement;
  mode: "drag" | "resize";
  corner?: ResizeCorner;
  startPoint: { x: number; y: number };
  startBounds: PixelBounds;
  startSettings: VisualSettings;
  nextSettings: VisualSettings;
};
type CanvasSizeState = { canvas: HTMLCanvasElement; width: number; height: number };
type CanvasGeometryState = {
  canvasSize: CanvasSizeState;
  geometry: VisualizationCompositionGeometry | null;
  settings: VisualSettings;
  logo: LogoLayer | null;
  artwork: LogoLayer | null;
  subtitles: SubtitleCue[];
};

export type CompositionEditorProps = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  settings: VisualSettings;
  logo?: LogoLayer | null;
  artwork?: LogoLayer | null;
  subtitles?: SubtitleCue[];
  time?: number;
  selectedElement: CompositionElement | null;
  onSelect: (element: CompositionElement | null) => void;
  onPreview?: (settings: VisualSettings | null) => void;
  onCommit: (next: VisualSettings, previous: VisualSettings) => void;
  disabled?: boolean;
  active?: boolean;
};

const CORNERS: ResizeCorner[] = ["nw", "ne", "sw", "se"];
const EMPTY_SUBTITLES: SubtitleCue[] = [];

function cornerPoint(bounds: PixelBounds, corner: ResizeCorner) {
  return {
    x: corner.includes("w") ? bounds.x : bounds.x + bounds.width,
    y: corner.includes("n") ? bounds.y : bounds.y + bounds.height,
  };
}

function snapAxis(position: number, size: number, limit: number, threshold: number) {
  const guides = [0, limit / 2, limit];
  const edges = [position, position + size, position + size / 2];
  let best = { position, distance: threshold + 1, guide: -1 };
  for (const guide of guides) {
    for (const edge of edges) {
      const distance = Math.abs(edge - guide);
      if (distance < best.distance) best = { position: position + guide - edge, distance, guide };
    }
  }
  return best.distance <= threshold
    ? { position: best.position, guide: best.guide }
    : { position, guide: -1 };
}

export function CompositionEditor({
  canvasRef,
  settings,
  logo = null,
  artwork = null,
  subtitles = EMPTY_SUBTITLES,
  time = 0,
  selectedElement,
  onSelect,
  onPreview,
  onCommit,
  disabled = false,
  active = true,
}: CompositionEditorProps) {
  // Selection bounds remain stable while audio time advances.
  void time;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [draftSettings, setDraftSettings] = useState<VisualSettings | null>(null);
  const [guides, setGuides] = useState<SnapGuides>({ x: [], y: [] });
  const renderedSettings = draftSettings ?? settings;
  const [canvasSize, setCanvasSize] = useState<CanvasSizeState | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasGeometryState | null>(null);

  useEffect(() => {
    const canvas = active ? canvasRef.current : null;
    if (!canvas) return;
    let pendingFrame: number | null = null;
    const measure = () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        const width = canvas.width;
        const height = canvas.height;
        setCanvasSize((previous) => {
          if (previous?.canvas === canvas && previous.width === width && previous.height === height)
            return previous;
          return { canvas, width, height };
        });
      });
    };
    measure();
    const attributes =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    attributes?.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    const dimensions = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    dimensions?.observe(canvas);
    return () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      attributes?.disconnect();
      dimensions?.disconnect();
    };
  }, [active, canvasRef]);

  useEffect(() => {
    if (!active || !canvasSize) return;
    let pendingFrame: number | null = requestAnimationFrame(() => {
      pendingFrame = null;
      const { canvas, width, height } = canvasSize;
      const context = width > 0 && height > 0 ? canvas.getContext("2d") : null;
      const geometry = context
        ? visualizationCompositionGeometry(
            context,
            width,
            height,
            renderedSettings,
            logo,
            artwork,
            subtitles,
            0,
          )
        : null;
      setCanvasState({
        canvasSize,
        geometry,
        settings: renderedSettings,
        logo,
        artwork,
        subtitles,
      });
    });
    return () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    };
  }, [active, canvasSize, renderedSettings, logo, artwork, subtitles]);

  const measurements =
    canvasState?.canvasSize === canvasSize &&
    canvasState?.settings === renderedSettings &&
    canvasState.logo === logo &&
    canvasState.artwork === artwork &&
    canvasState.subtitles === subtitles
      ? canvasState
      : null;
  const canvas = measurements?.canvasSize.canvas ?? null;
  const geometry = measurements?.geometry ?? null;
  const bounds = selectedElement ? geometry?.[selectedElement] : undefined;
  const aspect: CompositionAspect | null =
    measurements && measurements.canvasSize.width && measurements.canvasSize.height
      ? compositionAspect(measurements.canvasSize.width, measurements.canvasSize.height)
      : null;

  const mapPoint = useCallback(
    (event: PointerEvent<SVGSVGElement>, allowOutside = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const point = pointerToCanvas(
        event.clientX,
        event.clientY,
        rect,
        canvas.width,
        canvas.height,
        allowOutside,
      );
      return point;
    },
    [canvasRef],
  );

  const updateGesture = useCallback(
    (gesture: Gesture, point: { x: number; y: number }) => {
      const canvas = canvasRef.current;
      if (!canvas || !aspect) return;
      const dx = point.x - gesture.startPoint.x;
      const dy = point.y - gesture.startPoint.y;
      let next: PixelBounds;
      let nextGuides: SnapGuides = { x: [], y: [] };
      if (gesture.mode === "drag") {
        next = {
          ...gesture.startBounds,
          x: gesture.startBounds.x + dx,
          y: gesture.startBounds.y + dy,
        };
        const displayed = canvas.getBoundingClientRect();
        const thresholdX = 8 * (canvas.width / Math.max(1, displayed.width));
        const thresholdY = 8 * (canvas.height / Math.max(1, displayed.height));
        const snapX = snapAxis(next.x, next.width, canvas.width, thresholdX);
        const snapY = snapAxis(next.y, next.height, canvas.height, thresholdY);
        next = { ...next, x: snapX.position, y: snapY.position };
        nextGuides = {
          x: snapX.guide < 0 ? [] : [snapX.guide],
          y: snapY.guide < 0 ? [] : [snapY.guide],
        };
      } else {
        const start = gesture.startBounds;
        const corner = gesture.corner ?? "se";
        const left = corner.includes("w");
        const top = corner.includes("n");
        const fixedX = left ? start.x + start.width : start.x;
        const fixedY = top ? start.y + start.height : start.y;
        const movingX = Math.max(0, Math.min(canvas.width, point.x));
        const movingY = Math.max(0, Math.min(canvas.height, point.y));
        next = {
          x: Math.min(fixedX, movingX),
          y: Math.min(fixedY, movingY),
          width: Math.max(14, Math.abs(movingX - fixedX)),
          height: Math.max(14, Math.abs(movingY - fixedY)),
        };
      }
      const normalized = pixelsToBounds(next, canvas.width, canvas.height);
      let nextSettings = {
        ...gesture.startSettings,
        composition: setCompositionBounds(
          gesture.startSettings.composition,
          aspect,
          gesture.element,
          normalized,
        ),
      };
      if (gesture.element === "logo") {
        const mode = gesture.startSettings.mode;
        const placements = { ...gesture.startSettings.logoPlacements };
        placements[mode] = {
          x: ((next.x + next.width / 2) / canvas.width) * 100,
          y: ((next.y + next.height / 2) / canvas.height) * 100,
          size: Math.min(
            100,
            Math.max(
              1,
              (Math.max(next.width, next.height) / Math.min(canvas.width, canvas.height)) * 100,
            ),
          ),
        };
        nextSettings = {
          ...nextSettings,
          logoAutoFit: { ...gesture.startSettings.logoAutoFit, [mode]: false },
          logoPlacements: placements,
        };
      }
      gesture.nextSettings = nextSettings;
      setDraftSettings(nextSettings);
      setGuides(nextGuides);
      onPreview?.(nextSettings);
    },
    [canvasRef, aspect, onPreview],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const canvas = canvasRef.current;
      if (!active || disabled || !canvas || !geometry || !aspect) return;
      const point = mapPoint(event);
      if (!point) return;
      event.preventDefault();
      event.currentTarget.focus();
      const target = event.target as SVGElement;
      const corner = target.dataset.resize as ResizeCorner | undefined;
      let element = selectedElement;
      let mode: Gesture["mode"] = "drag";
      let startBounds = element ? geometry[element] : undefined;
      if (corner && element && startBounds) {
        mode = "resize";
      } else {
        element = hitTestComposition(geometry, point);
        if (!element) {
          onSelect(null);
          return;
        }
        startBounds = geometry[element];
        onSelect(element);
      }
      if (!startBounds || !element) return;
      svgRef.current?.setPointerCapture(event.pointerId);
      const gesture: Gesture = {
        pointerId: event.pointerId,
        element,
        mode,
        corner,
        startPoint: point,
        startBounds,
        startSettings: settings,
        nextSettings: settings,
      };
      gestureRef.current = gesture;
    },
    [active, disabled, canvasRef, geometry, aspect, mapPoint, selectedElement, settings, onSelect],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      const point = mapPoint(event, true);
      if (point) updateGesture(gesture, point);
    },
    [mapPoint, updateGesture],
  );

  const finishGesture = useCallback(
    (event?: PointerEvent<SVGSVGElement>, canceled = false) => {
      const gesture = gestureRef.current;
      if (!gesture || (event && gesture.pointerId !== event.pointerId)) return;
      gestureRef.current = null;
      if (event && svgRef.current?.hasPointerCapture(event.pointerId))
        svgRef.current.releasePointerCapture(event.pointerId);
      setGuides({ x: [], y: [] });
      setDraftSettings(null);
      onPreview?.(null);
      if (
        !canceled &&
        JSON.stringify(gesture.startSettings) !== JSON.stringify(gesture.nextSettings)
      )
        onCommit(gesture.nextSettings, gesture.startSettings);
    },
    [onPreview, onCommit],
  );

  const nudge = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      const canvas = canvasRef.current;
      if (!selectedElement || !bounds || !canvas || !aspect || disabled) return;
      if (event.key === "Escape") {
        finishGesture(undefined, true);
        return;
      }
      const direction =
        event.key === "ArrowLeft"
          ? [-1, 0]
          : event.key === "ArrowRight"
            ? [1, 0]
            : event.key === "ArrowUp"
              ? [0, -1]
              : event.key === "ArrowDown"
                ? [0, 1]
                : null;
      if (!direction) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const nextBounds = clampCompositionBounds(
        pixelsToBounds(
          {
            ...bounds,
            x: bounds.x + direction[0] * step,
            y: bounds.y + direction[1] * step,
          },
          canvas.width,
          canvas.height,
        ),
      );
      const next = {
        ...settings,
        composition: setCompositionBounds(
          settings.composition,
          aspect,
          selectedElement,
          nextBounds,
        ),
      };
      if (selectedElement === "logo") {
        const mode = settings.mode;
        const placements = { ...settings.logoPlacements };
        placements[mode] = {
          x: ((bounds.x + direction[0] * step + bounds.width / 2) / canvas.width) * 100,
          y: ((bounds.y + direction[1] * step + bounds.height / 2) / canvas.height) * 100,
          size: Math.min(
            100,
            Math.max(
              1,
              (Math.max(bounds.width, bounds.height) / Math.min(canvas.width, canvas.height)) * 100,
            ),
          ),
        };
        next.logoAutoFit = { ...settings.logoAutoFit, [mode]: false };
        next.logoPlacements = placements;
      }
      onCommit(next, settings);
    },
    [selectedElement, bounds, canvasRef, aspect, disabled, settings, onCommit, finishGesture],
  );

  if (!canvas || !geometry || !active) return null;
  const width = canvas.width;
  const height = canvas.height;
  const handleSize = Math.max(8, Math.min(width, height) * 0.016);
  return (
    <svg
      ref={svgRef}
      className={`composition-editor-overlay${disabled ? " is-disabled" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="application"
      aria-label="Canvas composition editor. Select an element, drag to move, use corner handles to resize, and arrow keys to nudge."
      tabIndex={selectedElement ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishGesture(event)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onKeyDown={nudge}
    >
      <rect x="0" y="0" width={width} height={height} fill="transparent" />
      {guides.x.map((x) => (
        <line key={`x-${x}`} x1={x} x2={x} y1={0} y2={height} className="composition-snap-guide" />
      ))}
      {guides.y.map((y) => (
        <line key={`y-${y}`} x1={0} x2={width} y1={y} y2={y} className="composition-snap-guide" />
      ))}
      {selectedElement && bounds ? (
        <g className="composition-selection" aria-label={`${selectedElement} selected`}>
          <rect
            x={bounds.x}
            y={bounds.y}
            width={bounds.width}
            height={bounds.height}
            className="composition-selection-box"
            fill="transparent"
          />
          {CORNERS.map((corner) => {
            const point = cornerPoint(bounds, corner);
            return (
              <rect
                key={corner}
                data-resize={corner}
                x={point.x - handleSize / 2}
                y={point.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                rx={handleSize * 0.16}
                className="composition-resize-handle"
              />
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}
