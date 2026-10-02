import { JsonlTailer } from './tail.js';
import { existsSync } from 'node:fs';

/** history.jsonl is shared. An exact prompt alone is insufficient: its native
 * session must also be the one bound by Dutydeck's unique session marker. */
export class CodexInputReceipt {
  private readonly history: JsonlTailer;
  constructor(private readonly path: string, nativeSessionId: () => string | undefined) {
    this.history = new JsonlTailer({
      resolvePath: () => path, mapEntry: () => undefined, watchForSwitch: false,
      inputText: entry => typeof entry.text === 'string' && typeof entry.session_id === 'string'
        // This shared journal has second-resolution timestamps. Missing time
        // cannot establish a receipt; an old append must not accept a new turn.
        && typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts > 0
        && entry.session_id === nativeSessionId() ? entry.text : undefined,
      inputTimestamp: entry => entry.ts * 1000,
    });
  }
  start(): void { this.history.start(); }
  async flush(): Promise<void> {
    try { await this.history.flush(); }
    catch (error) {
      // The shared input journal is optional; a native rollout can still
      // prove receipt. Losing the journal never counts as acknowledgement.
      if (existsSync(this.path)) throw error;
    }
  }
  stop(): void { this.history.stop(); }
  waitForInput(rollout: JsonlTailer, prompt: string, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    return Promise.race([
      rollout.waitForInput(prompt, controller.signal), this.history.waitForInput(prompt, controller.signal),
    ]).finally(() => {
      signal.removeEventListener('abort', abort);
      controller.abort(new Error('Native input receipt observed or retired'));
    });
  }
}
