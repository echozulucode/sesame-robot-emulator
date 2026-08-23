/**
 * Exponential backoff with jitter.
 *
 * The jitter is not decoration. Renode's socket terminal accepts one client;
 * when it restarts, every bridge instance that was watching it retries at the
 * same instant, and a deterministic delay makes them collide again on every
 * attempt. A +/- fraction breaks the lockstep.
 */
import type { BackoffConfig } from './config.js';

export class Backoff {
  #attempt = 0;

  constructor(
    private readonly config: BackoffConfig,
    /** Injectable for tests; defaults to Math.random. */
    private readonly random: () => number = Math.random,
  ) {}

  /** Attempts made since the last {@link reset}. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Delay for the next attempt, in ms. Never negative. */
  next(): number {
    const { initialMs, maxMs, factor, jitter } = this.config;
    const base = Math.min(maxMs, initialMs * factor ** this.#attempt);
    this.#attempt++;
    const spread = base * jitter;
    return Math.max(0, Math.round(base + (this.random() * 2 - 1) * spread));
  }

  reset(): void {
    this.#attempt = 0;
  }
}
