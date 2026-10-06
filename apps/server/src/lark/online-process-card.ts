import { setTimeout as delay } from 'node:timers/promises';
import { LarkServiceError, type LarkCardService } from './service.js';
import { isLarkCardContentRejected, isLarkMessageRateLimit, isLarkMessageUnupdatable, larkRateLimitBackoffMs, patchRejectedCardDelta, type LarkCardElement } from './card-renderer.js';
import { QUEUE_SUMMARY_ELEMENT_ID } from './queue-summary.js';

type CardUpdate = Parameters<LarkCardService['update']>[0];
export type CardUpdateOutcome = { delivered: boolean; messageId?: string; error?: unknown };
type CardDelivery = CardUpdateOutcome & {
  state: CardUpdate['state'];
  frozen: boolean;
  repaired?: boolean;
  elements?: LarkCardElement[];
};
type PendingUpdate = {
  input: CardUpdate;
  terminal: boolean;
  receipt: boolean;
  settle: (outcome: CardUpdateOutcome) => void;
};

/** One process card in one task turn. Task ownership and shared mapping persistence stay with the caller. */
export class OnlineProcessCard {
  private pending?: PendingUpdate;
  private flushing = false;
  private terminalLatched = false;
  private receiptLatched = false;
  private frozen: boolean;
  private unupdatable = false;
  private elements?: LarkCardElement[];
  private rateLimitFailures = 0;
  private rateLimitedUntil = 0;

  constructor(private readonly options: {
    service: Pick<LarkCardService, 'update' | 'withRequestBudget'>;
    messageId: string;
    isCurrent: () => boolean;
    frozen?: boolean;
    elements?: LarkCardElement[];
    report: (delivery: CardDelivery) => Promise<void>;
  }) {
    this.frozen = Boolean(options.frozen);
    this.elements = options.elements;
  }

  update(input: CardUpdate): Promise<CardUpdateOutcome> {
    return this.enqueue(input, false);
  }

  /** A cancelled, absorbed task uses its process card as the final receipt, even if already frozen. */
  rewriteReceipt(input: CardUpdate): Promise<CardUpdateOutcome> {
    return this.enqueue(input, true);
  }

  private enqueue(input: CardUpdate, receipt: boolean): Promise<CardUpdateOutcome> {
    const terminal = receipt || ['completed', 'failed', 'interrupted', 'cancelled'].includes(input.state ?? '');
    if (!this.options.isCurrent() || input.messageId !== this.options.messageId || this.unupdatable
      || (this.receiptLatched && !receipt) || (this.terminalLatched && !terminal) || (this.frozen && !receipt)) {
      return Promise.resolve({ delivered: false });
    }
    if (terminal) this.terminalLatched = true;
    if (receipt) this.receiptLatched = true;
    return new Promise(resolve => {
      this.pending?.settle({ delivered: false });
      this.pending = { input, terminal, receipt, settle: resolve };
      void this.flush();
    });
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        let outcome: CardUpdateOutcome = { delivered: false };
        try {
          outcome = await this.deliver(pending);
        } finally {
          // A coalesced frame, failed PATCH, or failed persistence must settle its own waiter.
          pending.settle(outcome);
        }
      }
    } finally {
      this.flushing = false;
      if (this.pending) void this.flush();
    }
  }

  private async deliver(pending: PendingUpdate): Promise<CardUpdateOutcome> {
    const current = () => this.options.isCurrent();
    const obsolete = () => !current() || (!pending.receipt && this.receiptLatched) || (!pending.terminal && this.terminalLatched);
    if (obsolete() || this.unupdatable || (this.frozen && !pending.receipt)) return { delivered: false };
    let delivered = false;
    let repaired = false;
    let lastError: unknown;
    let successfulElements: LarkCardElement[] | undefined;
    const attempts = pending.terminal ? 3 : 1;
    const deliver = async (signal?: AbortSignal) => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (obsolete() || signal?.aborted) return;
        try {
          const cooldown = this.rateLimitedUntil - Date.now();
          if (cooldown > 0) await delay(cooldown, undefined, { signal });
          if (obsolete() || signal?.aborted) return;
          await this.options.service.update(pending.input);
          delivered = true;
          lastError = undefined;
          successfulElements = pending.input.elements as LarkCardElement[] | undefined;
          this.rateLimitFailures = 0;
          this.rateLimitedUntil = 0;
          break;
        } catch (error) {
          lastError = error;
          if (obsolete()) break;
          if (isLarkCardContentRejected(error)) {
            // Keep the last accepted content and repair this same card; never send a replacement.
            if (this.elements?.length) {
              const elements = patchRejectedCardDelta(this.elements, pending.input.elements as LarkCardElement[] | undefined);
              try {
                await this.options.service.update({ ...pending.input, elements, markdown: undefined });
                delivered = true;
                lastError = undefined;
                successfulElements = elements;
                repaired = true;
              } catch (error) { lastError = error; }
            }
            break;
          }
          if (isLarkMessageUnupdatable(error)) break;
          if (isLarkMessageRateLimit(error)) {
            this.rateLimitedUntil = Date.now() + larkRateLimitBackoffMs(++this.rateLimitFailures);
          }
          if (signal?.aborted || (error as { larkRequestExhausted?: boolean })?.larkRequestExhausted
            || error instanceof LarkServiceError && ['LARK_REQUEST_BUDGET_EXHAUSTED', 'LARK_CIRCUIT_OPEN'].includes(error.code)
            || ['AbortError', 'TimeoutError'].includes((error as Error)?.name)) break;
          if (attempt < attempts && !isLarkMessageRateLimit(error)) {
            try { await delay(attempt * 300, undefined, { signal }); } catch (error) { lastError = error; break; }
          }
        }
      }
    };
    try {
      if (this.options.service.withRequestBudget) await this.options.service.withRequestBudget(deliver);
      else await deliver();
    } catch (error) { lastError = error; }
    const outcome = { delivered, ...(delivered ? { messageId: this.options.messageId } : {}), ...(lastError ? { error: lastError } : {}) };
    if (!current() || !pending.receipt && this.receiptLatched) return outcome;
    if (successfulElements) {
      // Queue counts are transient; reconciliation must not replay an old count after restart.
      this.elements = successfulElements.filter(element => element.element_id !== QUEUE_SUMMARY_ELEMENT_ID);
    }
    if (lastError && isLarkMessageUnupdatable(lastError)) this.unupdatable = true;
    if (this.unupdatable || delivered && pending.terminal) this.frozen = true;
    // Reporting may persist shared task state. A failure there does not undo delivery.
    try {
      await this.options.report({ ...outcome, state: pending.input.state, frozen: this.frozen, elements: this.elements, ...(repaired ? { repaired } : {}) });
    } catch { /* The reporting boundary owns persistence diagnostics and reconciliation. */ }
    return outcome;
  }
}
