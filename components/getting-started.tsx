import "./export-workflows.css";
import { ArrowRight, Image, Music2, Sparkles, UserRoundPen, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function GettingStarted({
  open,
  onOpenChange,
  hasMedia,
  onTrySample,
  onChooseLook,
  onOpenComposition,
  onOpenArtist,
  onOpenExport,
  onOpenRelease,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasMedia: boolean;
  onTrySample: () => void;
  onChooseLook: () => void;
  onOpenComposition: () => void;
  onOpenArtist?: () => void;
  onOpenExport: () => void;
  onOpenRelease: () => void;
}) {
  const runAction = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="getting-started-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <Sparkles size={19} />
          </div>
          <DialogTitle>Make and release a visual</DialogTitle>
          <DialogDescription>
            Start with a sample or your own media. Your source files and exports stay on this
            device.
          </DialogDescription>
        </DialogHeader>
        <ol className="getting-started-steps">
          <li>
            <span className="getting-started-number">1</span>
            <div>
              <strong>Add audio or video</strong>
              <p>
                Open a local file, or try the built-in sample to see how the visualizer responds.
              </p>
            </div>
            {!hasMedia && (
              <button className="button button-soft" onClick={() => runAction(onTrySample)}>
                <Music2 size={15} /> Try sample
              </button>
            )}
          </li>
          <li>
            <span className="getting-started-number">2</span>
            <div>
              <strong>Choose a look</strong>
              <p>
                Apply a Quick Look, then adjust color, motion and visual settings to fit the track.
              </p>
            </div>
            <button className="text-button" onClick={() => runAction(onChooseLook)}>
              Browse looks <ArrowRight size={14} />
            </button>
          </li>
          <li>
            <span className="getting-started-number">3</span>
            <div>
              <strong>Arrange the composition</strong>
              <p>
                Place artwork, logo, track details and captions in the canvas. Save the project file
                to continue later.
              </p>
            </div>
            <div className="getting-started-actions">
              <button className="text-button" onClick={() => runAction(onOpenComposition)}>
                <Image size={14} /> Edit canvas
              </button>
              {onOpenArtist && (
                <button className="text-button" onClick={() => runAction(onOpenArtist)}>
                  <UserRoundPen size={14} /> Track identity
                </button>
              )}
            </div>
          </li>
          <li>
            <span className="getting-started-number">4</span>
            <div>
              <strong>Export the files you need</strong>
              <p>
                Choose a range and video settings, or build a package with a full video, portrait
                teaser and PNG thumbnail.
              </p>
            </div>
            <div className="getting-started-actions">
              <button className="button button-soft" onClick={() => runAction(onOpenExport)}>
                <Video size={15} /> Export video
              </button>
              <button className="button export-button" onClick={() => runAction(onOpenRelease)}>
                Build release package
              </button>
            </div>
          </li>
        </ol>
        <p className="getting-started-note">
          No account is needed. Presets, projects and media remain in your browser or on your
          device.
        </p>
      </DialogContent>
    </Dialog>
  );
}
