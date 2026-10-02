/** Bounds increments produced after the initial snapshot but before subscription. */
export class OutputHandoff {
  private callbacks: Array<(data: string) => void> = [];
  private gaps: Array<(bytes: number) => void> = [];
  private pending = '';
  private bytes = 0;
  private dropped = 0;

  data(data: string): void {
    if (!data) return;
    if (this.callbacks.length) { this.deliver(data); return; }
    const bytes = Buffer.byteLength(data);
    if (this.dropped || this.bytes + bytes > 256 * 1024) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + this.bytes + bytes);
      this.pending = ''; this.bytes = 0;
    } else { this.pending += data; this.bytes += bytes; }
  }
  gap(bytes: number): void {
    if (this.callbacks.length) {
      if (this.gaps.length) for (const callback of this.gaps) callback(bytes);
      else this.deliver('\r\n[DutyDeck: terminal output was truncated.]\r\n');
    } else {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + this.bytes + bytes);
      this.pending = ''; this.bytes = 0;
    }
  }
  onData(callback: (data: string) => void): void {
    this.callbacks.push(callback);
    const pending = this.pending, dropped = this.dropped;
    this.pending = ''; this.bytes = 0; this.dropped = 0;
    if (dropped) {
      // Do not replay increments from the obsolete snapshot boundary after gap.
      if (this.gaps.length) for (const gap of this.gaps) gap(dropped);
      else this.deliver('\r\n[DutyDeck: terminal output was truncated before subscription.]\r\n');
    } else if (pending) this.deliver(pending);
  }
  onGap(callback: (bytes: number) => void): void { this.gaps.push(callback); }
  reset(clearSubscriptions = true): void {
    this.pending = ''; this.bytes = 0; this.dropped = 0;
    if (clearSubscriptions) { this.callbacks = []; this.gaps = []; }
  }
  private deliver(data: string): void {
    for (const callback of this.callbacks) { try { callback(data); } catch { /* isolate listeners */ } }
  }
}
