export interface ProgressOptions {
  /** How often a long copy logs its progress. */
  reportEveryMs: number;
  /** Warn when nothing has completed for this long. */
  stallAfterMs: number;
}

export const DEFAULT_PROGRESS: ProgressOptions = {
  reportEveryMs: 5_000,
  stallAfterMs: 30_000,
};

/**
 * Tracks the operation in progress and warns when nothing completes for a
 * while, so a stuck server call (e.g. an index build waiting for a replica
 * set's commit quorum) shows up in the log instead of as silence.
 */
export class Progress {
  readonly #options: ProgressOptions;
  readonly #warn: (message: string) => void;
  #timer: NodeJS.Timeout | undefined;
  #operation = 'starting';
  #operationStarted = Date.now();
  #lastActivity = Date.now();
  #stallReported = false;

  constructor(options: ProgressOptions, warn: (message: string) => void) {
    this.#options = options;
    this.#warn = warn;
  }

  start(): void {
    const every = Math.max(
      100,
      Math.min(1_000, this.#options.stallAfterMs / 2),
    );
    this.#timer = setInterval(() => this.#check(), every);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** A new server call or step starts. */
  operation(description: string): void {
    this.#operation = description;
    this.#operationStarted = Date.now();
    this.activity();
  }

  /** Something completed (a batch was read or written). */
  activity(): void {
    this.#lastActivity = Date.now();
    this.#stallReported = false;
  }

  #check(): void {
    const now = Date.now();
    const idle = now - this.#lastActivity;
    if (this.#stallReported || idle < this.#options.stallAfterMs) return;

    this.#stallReported = true;
    const running = Math.round((now - this.#operationStarted) / 1000);
    const hint = this.#operation.startsWith('createIndexes')
      ? ' On a replica set, index builds wait for the commit quorum; check db.currentOp() on the target and see --indexCommitQuorum.'
      : '';
    this.#warn(
      `No progress for ${Math.round(idle / 1000)}s: ${this.#operation} (running ${running}s).${hint}`,
    );
  }
}

/** `12,000/35,000 (34%), 9,800 docs/s, ETA 2s` */
export function describeProgress(
  done: number,
  total: number,
  elapsedMs: number,
): string {
  const rate = elapsedMs > 0 ? (done * 1000) / elapsedMs : 0;
  const format = (n: number) => Math.round(n).toLocaleString('en-US');
  if (total <= 0 || done > total) {
    return `${format(done)} documents, ${format(rate)} docs/s`;
  }
  const percent = Math.floor((done * 100) / total);
  const eta = rate > 0 ? formatDuration(((total - done) * 1000) / rate) : '?';
  return `${format(done)}/${format(total)} (${percent}%), ${format(rate)} docs/s, ETA ${eta}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
