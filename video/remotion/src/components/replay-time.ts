/** Session time (s) at a component frame: start offset plus speed, held at `freezeAt` when given. */
export function replayTime(frame: number, fps: number, startAt: number, speed: number, freezeAt: number | undefined): number {
  const t = startAt + (frame / fps) * speed;
  return freezeAt === undefined ? t : Math.min(t, freezeAt);
}
