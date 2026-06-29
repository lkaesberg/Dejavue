import { childLogger, type ProgressEmbed } from '@dejavue/core';
import { patchMessage, type RawEmbed } from './discordRest';

const log = childLogger({ mod: 'progress' });

export interface LiveProgressOpts {
  channelId: string;
  messageId: string;
  /** Minimum gap between edits; bursts coalesce to the latest state. Default 1.5s. */
  minIntervalMs?: number;
}

function toRaw(e: ProgressEmbed): RawEmbed {
  return { title: e.title, description: e.description, color: e.color };
}

/**
 * Throttled, serialized updater for the one live-progress message a job owns. All
 * edits go through an internal promise chain (never concurrent), `update()` coalesces
 * rapid calls behind a min-interval timer, and `finalize()`/`fail()` flush the terminal
 * state immediately and resolve only once it has actually landed. A failed patch (e.g.
 * the user deleted the message) is swallowed-and-logged so it never crashes the job.
 */
export class LiveProgress {
  private readonly channelId: string;
  private readonly messageId: string;
  private readonly minIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();
  private pending: ProgressEmbed | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;

  constructor(opts: LiveProgressOpts) {
    this.channelId = opts.channelId;
    this.messageId = opts.messageId;
    this.minIntervalMs = opts.minIntervalMs ?? 1500;
  }

  update(embed: ProgressEmbed): void {
    this.pending = embed;
    if (this.timer) return;
    const wait = Math.max(0, this.lastSent + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) {
        const e = this.pending;
        this.pending = null;
        void this.send(e);
      }
    }, wait);
    this.timer.unref?.();
  }

  async finalize(embed: ProgressEmbed): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    await this.send(embed);
  }

  /** Alias for finalize with an error embed (semantic sugar at call sites). */
  async fail(embed: ProgressEmbed): Promise<void> {
    await this.finalize(embed);
  }

  private send(embed: ProgressEmbed): Promise<void> {
    this.lastSent = Date.now();
    this.chain = this.chain.then(() =>
      patchMessage(this.channelId, this.messageId, { embeds: [toRaw(embed)] }).catch((err) => {
        log.warn({ err, channelId: this.channelId, messageId: this.messageId }, 'progress edit failed');
      }),
    );
    return this.chain;
  }
}
