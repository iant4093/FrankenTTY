// Byte chunks -> exact frames (REQ-INGEST-05, REQ-INGEST-06). Pure: no I/O.
//
// A pool of `capacity + 1` buffers is allocated once. They rotate between three roles:
// queued (completed, waiting to be taken, at most `capacity`), held (returned by the last
// take*, valid until the next take*), and fill (receiving bytes). The fill buffer is
// acquired lazily on the first byte of a frame, so a caller that stops pushing when
// `isFull()` is true never needs more than `capacity + 1` buffers.
//
// A caller that keeps pushing past capacity loses the oldest queued frames, and they are
// counted in `dropped`. Use `bytesUntilFull()` to push without dropping.

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('FrameAssembler invariant violated');
  return value;
}

export class FrameAssembler {
  readonly frameSize: number;
  readonly capacity: number;
  /** Frames fully assembled since construction or the last reset(). */
  framesCompleted = 0;
  /** Completed frames discarded without being returned by take*. */
  dropped = 0;

  readonly #pool: Uint8Array[];
  #poolCount: number;
  readonly #queue: (Uint8Array | undefined)[];
  #head = 0;
  #length = 0;
  #fill: Uint8Array | null = null;
  #fillLength = 0;
  #held: Uint8Array | null = null;

  constructor(frameSize: number, capacity = 4) {
    if (!Number.isInteger(frameSize) || frameSize < 1) {
      throw new RangeError(`frameSize must be a positive integer, got ${String(frameSize)}`);
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.frameSize = frameSize;
    this.capacity = capacity;
    this.#pool = [];
    for (let i = 0; i < capacity + 1; i++) this.#pool.push(new Uint8Array(frameSize));
    this.#poolCount = capacity + 1;
    this.#queue = new Array<Uint8Array | undefined>(capacity).fill(undefined);
  }

  /** Completed frames waiting to be taken. */
  get queued(): number {
    return this.#length;
  }

  /** Bytes of the frame currently being filled. */
  get trailingBytes(): number {
    return this.#fillLength;
  }

  isFull(): boolean {
    return this.#length === this.capacity;
  }

  /** How many more bytes can be pushed before the queue is full (0 when full). */
  bytesUntilFull(): number {
    return (this.capacity - this.#length) * this.frameSize - this.#fillLength;
  }

  /** Copies `chunk` into frame buffers. Returns the queue length afterwards. */
  push(chunk: Uint8Array): number {
    const total = chunk.length;
    let offset = 0;
    while (offset < total) {
      if (this.#fill === null) {
        this.#fill = this.#acquire();
        this.#fillLength = 0;
      }
      const n = Math.min(this.frameSize - this.#fillLength, total - offset);
      this.#fill.set(n === total ? chunk : chunk.subarray(offset, offset + n), this.#fillLength);
      this.#fillLength += n;
      offset += n;
      if (this.#fillLength === this.frameSize) this.#complete(this.#fill);
    }
    return this.#length;
  }

  /** Removes and returns the oldest queued frame, or null. Valid until the next take*. */
  takeOldest(): Uint8Array | null {
    if (this.#length === 0) return null;
    this.#releaseHeld();
    return this.#popOldestIntoHeld();
  }

  /** Returns the newest queued frame and drops (and counts) the older ones, or null. */
  takeLatest(): Uint8Array | null {
    if (this.#length === 0) return null;
    this.#releaseHeld();
    while (this.#length > 1) this.#dropOldest();
    return this.#popOldestIntoHeld();
  }

  /** Discards everything and zeroes the counters. Invalidates any buffer handed out before. */
  reset(): void {
    this.#releaseHeld();
    while (this.#length > 0) {
      this.#release(must(this.#shift()));
    }
    if (this.#fill !== null) this.#release(this.#fill);
    this.#fill = null;
    this.#fillLength = 0;
    this.framesCompleted = 0;
    this.dropped = 0;
  }

  #complete(buf: Uint8Array): void {
    if (this.#length === this.capacity) this.#dropOldest();
    this.#queue[(this.#head + this.#length) % this.capacity] = buf;
    this.#length++;
    this.framesCompleted++;
    this.#fill = null;
    this.#fillLength = 0;
  }

  #shift(): Uint8Array | undefined {
    if (this.#length === 0) return undefined;
    const buf = this.#queue[this.#head];
    this.#queue[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.capacity;
    this.#length--;
    return buf;
  }

  #popOldestIntoHeld(): Uint8Array {
    const buf = must(this.#shift());
    this.#held = buf;
    return buf;
  }

  #dropOldest(): void {
    this.#release(must(this.#shift()));
    this.dropped++;
  }

  #release(buf: Uint8Array): void {
    this.#pool[this.#poolCount++] = buf;
  }

  #releaseHeld(): void {
    if (this.#held !== null) {
      this.#release(this.#held);
      this.#held = null;
    }
  }

  #acquire(): Uint8Array {
    if (this.#poolCount === 0) this.#dropOldest();
    return must(this.#pool[--this.#poolCount]);
  }
}

/**
 * Wraps FrameAssembler with generation IDs (REQ-INGEST-05). Chunks tagged with any
 * generation other than the current one are ignored and counted in `staleChunks`.
 */
export class GenerationalAssembler {
  readonly capacity: number;
  /** Chunks ignored because their generation was not the current one. */
  staleChunks = 0;

  #generation = -1;
  #assembler: FrameAssembler | null = null;

  constructor(capacity = 4) {
    this.capacity = capacity;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Begins a new generation. Resets all state; reuses the pool when the frame size is unchanged. */
  start(generation: number, frameSize: number): void {
    this.#generation = generation;
    this.staleChunks = 0;
    if (this.#assembler !== null && this.#assembler.frameSize === frameSize) {
      this.#assembler.reset();
    } else {
      this.#assembler = new FrameAssembler(frameSize, this.capacity);
    }
  }

  /** Returns the queue length after the push (unchanged for stale chunks). */
  push(generation: number, chunk: Uint8Array): number {
    if (generation !== this.#generation || this.#assembler === null) {
      this.staleChunks++;
      return this.queued;
    }
    return this.#assembler.push(chunk);
  }

  get queued(): number {
    return this.#assembler?.queued ?? 0;
  }

  get framesCompleted(): number {
    return this.#assembler?.framesCompleted ?? 0;
  }

  get dropped(): number {
    return this.#assembler?.dropped ?? 0;
  }

  get trailingBytes(): number {
    return this.#assembler?.trailingBytes ?? 0;
  }

  isFull(): boolean {
    return this.#assembler?.isFull() ?? false;
  }

  bytesUntilFull(): number {
    return this.#assembler?.bytesUntilFull() ?? 0;
  }

  takeOldest(): Uint8Array | null {
    return this.#assembler?.takeOldest() ?? null;
  }

  takeLatest(): Uint8Array | null {
    return this.#assembler?.takeLatest() ?? null;
  }
}
