// Shared shape for probe results and demo metadata (REQ-INGEST-01, REQ-INGEST-03).
// Owned by architect-opus so parallel tasks 2.1 and 2.2 share one definition.

export type MediaSource = 'demo' | 'file' | 'url';

export interface MediaInfo {
  /** Display width in pixels (sample aspect ratio and rotation applied). */
  width: number;
  /** Display height in pixels. */
  height: number;
  /** Frames per second of the source. */
  fps: number;
  /** Duration in seconds, or null when unknown. */
  durationSec: number | null;
  hasAudio: boolean;
  source: MediaSource;
}
