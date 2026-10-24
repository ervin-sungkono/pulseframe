import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { activeVisualizers, type Composition, type FrameTransform } from "../composition/model";
import { boundedTransform, hitFrame } from "../composition/geometry";
import type { VisualMode } from "../visual/visual-settings-model";
export type CompositionInteractionOptions = {
  composition: Composition;
  mode: VisualMode;
  selectedId: string | null;
  disabled?: boolean;
  onSelect(id: string | null): void;
  onChange(composition: Composition, group?: string): void;
};
type Gesture = {
  id: string;
  kind: string;
  pointer: number;
  x: number;
  y: number;
  rect: DOMRect;
  frame: FrameTransform;
  group: string;
};
export function useCompositionInteraction(options: CompositionInteractionOptions) {
  const gesture = useRef<Gesture | null>(null);
  const items = [
    ...activeVisualizers(options.composition, options.mode),
    ...options.composition.elements.filter((item) => item.visible),
  ];
  const selected = items.find((item) => item.id === options.selectedId);
  const change = (
    composition: Composition,
    id: string,
    transform: FrameTransform,
    group?: string,
  ) => {
    const update = <T extends { id: string; transform: FrameTransform }>(item: T) =>
      item.id === id ? { ...item, transform: boundedTransform(transform) } : item;
    options.onChange(
      {
        ...composition,
        visualizers: composition.visualizers.map(update),
        elements: composition.elements.map(update),
      },
      group,
    );
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (options.disabled || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const handle = (event.target as HTMLElement).dataset.handle;
    const item = handle
      ? selected
      : [...items]
          .reverse()
          .find((item) =>
            hitFrame(
              item.transform,
              event.clientX - rect.x,
              event.clientY - rect.y,
              rect.width,
              rect.height,
            ),
          );
    options.onSelect(item?.id ?? null);
    // Touching the canvas selects; only explicit handles start a drag so a
    // vertical swipe can still scroll the mobile workspace.
    if (event.pointerType === "touch" && !handle) return;
    if (!item || item.locked) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id: item.id,
      kind: handle ?? "move",
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect,
      frame: item.transform,
      group: `canvas:${crypto.randomUUID()}`,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const job = gesture.current;
    if (!job || job.pointer !== event.pointerId || options.disabled) return;
    const dx = event.clientX - job.x,
      dy = event.clientY - job.y;
    const frame = { ...job.frame };
    if (job.kind === "move") {
      frame.x += dx / job.rect.width;
      frame.y += dy / job.rect.height;
    } else if (job.kind === "rotate") {
      const cx = job.rect.x + frame.x * job.rect.width,
        cy = job.rect.y + frame.y * job.rect.height;
      const angle =
        ((Math.atan2(event.clientY - cy, event.clientX - cx) - Math.atan2(job.y - cy, job.x - cx)) *
          180) /
        Math.PI;
      frame.rotation = ((frame.rotation + angle + 540) % 360) - 180;
    } else {
      const angle = (frame.rotation * Math.PI) / 180;
      const x = dx * Math.cos(angle) + dy * Math.sin(angle),
        y = -dx * Math.sin(angle) + dy * Math.cos(angle);
      frame.width += ((job.kind.includes("w") ? -1 : 1) * 2 * x) / job.rect.width;
      frame.height += ((job.kind.includes("n") ? -1 : 1) * 2 * y) / job.rect.height;
      if (event.shiftKey) frame.height = (frame.width * job.frame.height) / job.frame.width;
    }
    change(options.composition, job.id, frame, job.group);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointer === event.pointerId) gesture.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (options.disabled) return;
    if (event.key === "Escape") {
      if (gesture.current) {
        change(
          options.composition,
          gesture.current.id,
          gesture.current.frame,
          gesture.current.group,
        );
        gesture.current = null;
      } else options.onSelect(null);
    }
    if (!selected || selected.locked) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const amount = event.shiftKey ? 0.02 : 0.005;
      change(
        options.composition,
        selected.id,
        {
          ...selected.transform,
          x:
            selected.transform.x +
            (event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0),
          y:
            selected.transform.y +
            (event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0),
        },
        `nudge:${selected.id}`,
      );
    }
  };
  return {
    selected,
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish,
    onKeyDown,
  };
}
