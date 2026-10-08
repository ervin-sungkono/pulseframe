import { useState } from "react";
import { Captions, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { timestamp } from "./export-dialog";
import type { SubtitleCue } from "@/lib/subtitles";

function readTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length > 2 || parts.some(part => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) ? seconds : null;
}

function CueTime({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (time: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="cue-time"><span>{label}</span><input inputMode="decimal" aria-label={`${label} timestamp`}
    value={draft ?? timestamp(value, true)} onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
    onBlur={() => { const parsed = readTime(draft ?? timestamp(value, true)); setDraft(null);
      if (parsed !== null) onChange(Math.min(max, Math.max(0, parsed))); }} /></label>;
}

export function SubtitleDialog({ open, onOpenChange, cues, onChange, position, duration, onSeek }: {
  open: boolean; onOpenChange: (open: boolean) => void; cues: SubtitleCue[];
  onChange: (cues: SubtitleCue[]) => void; position: number; duration: number; onSeek: (time: number) => void;
}) {
  const update = (id: string, change: Partial<SubtitleCue>) => onChange(cues.map(cue => cue.id === id ? { ...cue, ...change } : cue));
  const add = () => {
    const start = Math.max(0, Math.min(position, Math.max(0, duration - .2)));
    const end = Math.min(duration, start + 2.5);
    const id = crypto.randomUUID();
    onChange([...cues, { id, start, end, text: "" }]);
  };
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const overlaps = sorted.some((cue, i) => i > 0 && cue.start < sorted[i - 1].end);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="subtitle-dialog">
      <DialogHeader>
        <div className="dialog-icon"><Captions size={19}/></div>
        <DialogTitle>Subtitles</DialogTitle>
        <DialogDescription>Add each line, then set when it starts and ends. These captions appear in your exported video.</DialogDescription>
      </DialogHeader>
      <div className="subtitle-topline"><span>{cues.length} {cues.length === 1 ? "block" : "blocks"}</span>
        <button className="button button-soft" onClick={add} disabled={!duration || cues.length >= 500}><Plus size={16}/> Add at {timestamp(position, true)}</button></div>
      <div className="subtitle-list">
        {!cues.length && <div className="subtitle-empty">Move to a point in your song, then add a subtitle block.</div>}
        {sorted.map((cue, index) => <div key={cue.id} className="subtitle-block">
          <div className="subtitle-block-heading"><strong>Block {index + 1}</strong><div>
            <button onClick={() => { onSeek(cue.start); onOpenChange(false); }} title="Preview at start" aria-label={`Preview block ${index + 1}`}>Preview</button>
            <button onClick={() => onChange(cues.filter(item => item.id !== cue.id))} title="Remove block" aria-label={`Remove block ${index + 1}`}><Trash2 size={15}/></button>
          </div></div>
          <textarea aria-label={`Subtitle text for block ${index + 1}`} placeholder="Type the subtitle here…" rows={2} maxLength={600}
            value={cue.text} onChange={event => update(cue.id, { text: event.target.value })}/>
          <div className="cue-range">
            <CueTime label={`Block ${index + 1} start`} value={cue.start} max={Math.max(0, cue.end - .1)}
              onChange={start => update(cue.id, { start })}/>
            <CueTime label={`Block ${index + 1} end`} value={cue.end} max={duration}
              onChange={end => update(cue.id, { end: Math.max(cue.start + .1, end) })}/>
          </div>
        </div>)}
      </div>
      {overlaps && <p className="subtitle-warning">Some blocks overlap. Only the earliest block will appear at that moment.</p>}
      <button className="button done-button subtitle-done" onClick={() => onOpenChange(false)}>Done</button>
    </DialogContent>
  </Dialog>;
}
