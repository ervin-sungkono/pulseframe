import "./export-workflows.css";
import { useState } from "react";
import { Eye, Image, PackageOpen, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { EXPORT_FRAME_RATES, type ExportFrameRate } from "@/lib/export-timeline";
import { EXPORT_RESOLUTIONS, exportDimensions, type ExportResolution } from "@/lib/export-settings";
import {
  createDefaultReleaseRecipe,
  makeReleaseRequests,
  type ReleaseRecipe,
  type ReleaseVideoOutput,
} from "@/lib/release-recipe";
import type { ExportSource } from "@/lib/export-job";
import type { ExportRequest } from "@/lib/export-request";

function stamp(seconds: number) {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.round((value % 1) * 10))}`;
}

function outputDetails(output: ReleaseVideoOutput) {
  const size = exportDimensions(output.aspect, output.resolution);
  return `${output.aspect === "landscape" ? "Landscape" : output.aspect === "portrait" ? "Portrait" : "Square"} · ${output.resolution}p · ${size.width} × ${size.height} · ${output.frameRate} fps · ${stamp(output.range[0])}–${stamp(output.range[1])}`;
}

function SelectField<T extends string | number>({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="release-select-field">
      <span>{label}</span>
      <select
        value={String(value)}
        onChange={(event) =>
          onChange(
            (typeof value === "number"
              ? Number(event.currentTarget.value)
              : event.currentTarget.value) as T,
          )
        }
      >
        {values.map((entry) => (
          <option key={entry} value={entry}>
            {typeof entry === "number" && label === "Resolution"
              ? `${entry}p`
              : typeof entry === "number" && label === "Frame rate"
                ? `${entry} fps`
                : entry}
          </option>
        ))}
      </select>
    </label>
  );
}

export type ReleaseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ExportSource | null;
  selectedTime: number;
  /** Initial local recipe. Key the dialog by project identity to reset it on project changes. */
  initialRecipe?: ReleaseRecipe | null;
  /** When supplied, the parent owns the recipe and receives every edit through onRecipeChange. */
  recipe?: ReleaseRecipe | null;
  onRecipeChange?: (recipe: ReleaseRecipe) => void;
  /** Opens a preview/details surface for one output, using the same request snapshot as export. */
  onInspect?: (request: ExportRequest) => void;
  onCreateRequests: (requests: ExportRequest[]) => void;
  onOpenBatch?: () => void;
};

function ReleaseDialogContent({
  open,
  onOpenChange,
  source,
  selectedTime,
  initialRecipe,
  recipe: controlledRecipe,
  onRecipeChange,
  onInspect,
  onCreateRequests,
  onOpenBatch,
}: ReleaseDialogProps) {
  const [localRecipe, setLocalRecipe] = useState<ReleaseRecipe | null>(() => {
    if (controlledRecipe) return controlledRecipe;
    if (initialRecipe) return initialRecipe;
    if (!source) return null;
    try {
      return createDefaultReleaseRecipe(source, selectedTime);
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const recipe = controlledRecipe ?? localRecipe;

  const changeRecipe = (next: ReleaseRecipe) => {
    if (!controlledRecipe) setLocalRecipe(next);
    onRecipeChange?.(next);
    setError("");
  };

  if (!source || !recipe) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="release-dialog">
          <DialogHeader>
            <div className="dialog-icon">
              <PackageOpen size={19} />
            </div>
            <DialogTitle>Release package</DialogTitle>
            <DialogDescription>
              Choose a project range before creating release files.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="release-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button button-soft" onClick={() => onOpenChange(false)}>
              Close
            </button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const [rangeStart, rangeEnd] = source.range;
  const updateVideo = (key: "fullVideo" | "portraitTeaser", patch: Partial<ReleaseVideoOutput>) => {
    changeRecipe({ ...recipe, [key]: { ...recipe[key], ...patch } });
  };
  const updateThumbnail = (patch: Partial<ReleaseRecipe["thumbnail"]>) => {
    changeRecipe({ ...recipe, thumbnail: { ...recipe.thumbnail, ...patch } });
  };
  const setTeaserRange = (start: number, end: number) => {
    const min = rangeStart;
    const max = rangeEnd;
    const safeStart = Math.max(min, Math.min(start, max - 0.1));
    const safeEnd = Math.max(safeStart + 0.1, Math.min(end, max));
    updateVideo("portraitTeaser", { range: [safeStart, safeEnd] });
  };

  const createPackage = () => {
    try {
      const requests = makeReleaseRequests(source, recipe);
      onCreateRequests(requests);
      onOpenChange(false);
      onOpenBatch?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the release package.");
    }
  };

  const inspect = (kind: "fullVideo" | "portraitTeaser" | "thumbnail") => {
    if (!onInspect) return;
    try {
      const inspectRecipe: ReleaseRecipe = {
        fullVideo: { ...recipe.fullVideo, enabled: kind === "fullVideo" },
        portraitTeaser: { ...recipe.portraitTeaser, enabled: kind === "portraitTeaser" },
        thumbnail: { ...recipe.thumbnail, enabled: kind === "thumbnail" },
      };
      const request = makeReleaseRequests(source, inspectRecipe)[0];
      onInspect(request);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not inspect this output.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="release-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <PackageOpen size={19} />
          </div>
          <DialogTitle>Build a release package</DialogTitle>
          <DialogDescription>
            Make separate files from this project. Each video keeps its own frame settings and time
            range.
          </DialogDescription>
        </DialogHeader>

        <section className="release-output-card">
          <label className="release-output-toggle">
            <input
              type="checkbox"
              checked={recipe.fullVideo.enabled}
              onChange={(event) =>
                updateVideo("fullVideo", { enabled: event.currentTarget.checked })
              }
            />
            <Video size={16} /> <strong>Full video</strong>
          </label>
          <p>
            {outputDetails(recipe.fullVideo)}
            {recipe.fullVideo.videoCompression ? " · compression on" : " · high quality"}
          </p>
          {onInspect && (
            <button
              className="text-button release-inspect-button"
              onClick={() => inspect("fullVideo")}
            >
              <Eye size={14} /> Inspect output
            </button>
          )}
          <div className="release-output-controls">
            <SelectField
              label="Resolution"
              value={recipe.fullVideo.resolution}
              values={EXPORT_RESOLUTIONS as readonly ExportResolution[]}
              onChange={(resolution) => updateVideo("fullVideo", { resolution })}
            />
            <SelectField
              label="Frame rate"
              value={recipe.fullVideo.frameRate}
              values={EXPORT_FRAME_RATES as readonly ExportFrameRate[]}
              onChange={(frameRate) => updateVideo("fullVideo", { frameRate })}
            />
            <label className="release-compression">
              <input
                type="checkbox"
                checked={recipe.fullVideo.videoCompression}
                onChange={(event) =>
                  updateVideo("fullVideo", { videoCompression: event.currentTarget.checked })
                }
              />{" "}
              Compress video
            </label>
          </div>
        </section>

        <section className="release-output-card">
          <label className="release-output-toggle">
            <input
              type="checkbox"
              checked={recipe.portraitTeaser.enabled}
              onChange={(event) =>
                updateVideo("portraitTeaser", { enabled: event.currentTarget.checked })
              }
            />
            <Video size={16} /> <strong>Portrait teaser</strong>
          </label>
          <p>
            {outputDetails(recipe.portraitTeaser)}
            {recipe.portraitTeaser.videoCompression ? " · compression on" : " · high quality"}
          </p>
          <Slider
            className="studio-slider range-slider"
            aria-label="Portrait teaser time range"
            value={recipe.portraitTeaser.range}
            min={rangeStart}
            max={rangeEnd}
            step={0.1}
            minStepsBetweenThumbs={1}
            disabled={!recipe.portraitTeaser.enabled || rangeEnd - rangeStart < 0.2}
            onValueChange={(values) => setTeaserRange(values[0], values[1])}
          />
          <div className="release-output-controls">
            <label className="release-select-field">
              <span>Start</span>
              <input
                type="number"
                min={rangeStart}
                max={rangeEnd - 0.1}
                step="0.1"
                value={recipe.portraitTeaser.range[0]}
                disabled={!recipe.portraitTeaser.enabled}
                onChange={(event) =>
                  setTeaserRange(Number(event.currentTarget.value), recipe.portraitTeaser.range[1])
                }
              />
            </label>
            <label className="release-select-field">
              <span>End</span>
              <input
                type="number"
                min={rangeStart + 0.1}
                max={rangeEnd}
                step="0.1"
                value={recipe.portraitTeaser.range[1]}
                disabled={!recipe.portraitTeaser.enabled}
                onChange={(event) =>
                  setTeaserRange(recipe.portraitTeaser.range[0], Number(event.currentTarget.value))
                }
              />
            </label>
            <SelectField
              label="Resolution"
              value={recipe.portraitTeaser.resolution}
              values={EXPORT_RESOLUTIONS as readonly ExportResolution[]}
              onChange={(resolution) => updateVideo("portraitTeaser", { resolution })}
            />
            <SelectField
              label="Frame rate"
              value={recipe.portraitTeaser.frameRate}
              values={EXPORT_FRAME_RATES as readonly ExportFrameRate[]}
              onChange={(frameRate) => updateVideo("portraitTeaser", { frameRate })}
            />
          </div>
          <p className="export-footnote">
            Starts with 30 seconds when the selected range allows it. Resize the handles or enter
            exact times.
          </p>
          {onInspect && (
            <button
              className="text-button release-inspect-button"
              onClick={() => inspect("portraitTeaser")}
            >
              <Eye size={14} /> Inspect output
            </button>
          )}
        </section>

        <section className="release-output-card">
          <label className="release-output-toggle">
            <input
              type="checkbox"
              checked={recipe.thumbnail.enabled}
              onChange={(event) => updateThumbnail({ enabled: event.currentTarget.checked })}
            />
            <Image size={16} /> <strong>Selected-time PNG</strong>
          </label>
          <p>
            {recipe.thumbnail.aspect === "landscape"
              ? "Landscape"
              : recipe.thumbnail.aspect === "portrait"
                ? "Portrait"
                : "Square"}{" "}
            · {recipe.thumbnail.resolution}p ·{" "}
            {exportDimensions(recipe.thumbnail.aspect, recipe.thumbnail.resolution).width} ×{" "}
            {exportDimensions(recipe.thumbnail.aspect, recipe.thumbnail.resolution).height} ·{" "}
            {stamp(recipe.thumbnail.time)}
          </p>
          <Slider
            className="studio-slider range-slider"
            aria-label="Thumbnail time"
            value={[recipe.thumbnail.time]}
            min={rangeStart}
            max={rangeEnd}
            step={0.1}
            disabled={!recipe.thumbnail.enabled || rangeEnd <= rangeStart}
            onValueChange={(values) => updateThumbnail({ time: values[0] })}
          />
          <div className="release-output-controls">
            <label className="release-select-field">
              <span>Frame time</span>
              <input
                type="number"
                min={rangeStart}
                max={rangeEnd}
                step="0.1"
                value={recipe.thumbnail.time}
                disabled={!recipe.thumbnail.enabled}
                onChange={(event) => updateThumbnail({ time: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="release-select-field">
              <span>Aspect</span>
              <select
                value={recipe.thumbnail.aspect}
                onChange={(event) =>
                  updateThumbnail({
                    aspect: event.currentTarget.value as ReleaseRecipe["thumbnail"]["aspect"],
                  })
                }
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
                <option value="square">Square</option>
              </select>
            </label>
            <SelectField
              label="Resolution"
              value={recipe.thumbnail.resolution}
              values={EXPORT_RESOLUTIONS as readonly ExportResolution[]}
              onChange={(resolution) => updateThumbnail({ resolution })}
            />
          </div>
          {onInspect && (
            <button
              className="text-button release-inspect-button"
              onClick={() => inspect("thumbnail")}
            >
              <Eye size={14} /> Preview and inspect PNG
            </button>
          )}
        </section>

        {error && (
          <p className="release-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button export-button" onClick={createPackage}>
            <PackageOpen size={16} /> Add outputs to batch
          </button>
          <button className="button button-soft" onClick={() => onOpenChange(false)}>
            Close
          </button>
        </div>
        <p className="export-footnote">
          The three outputs use one project snapshot and export sequentially. Media stays on this
          device.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function ReleaseDialog(props: ReleaseDialogProps) {
  const source = props.source;
  const sourceKey = source
    ? `${source.generation ?? ""}:${source.file.name}:${source.file.size}:${source.file.lastModified}:${source.range.join(":")}:${source.duration}:${source.tracks?.map((track) => `${track.id}:${track.range.join("-")}`).join("|") ?? ""}`
    : "empty";
  return <ReleaseDialogContent key={sourceKey} {...props} />;
}
