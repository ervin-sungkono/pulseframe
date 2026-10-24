/** Preview-only hysteresis. Source time and export dimensions never depend on it. */
export class PreviewQuality {
  private level = 0;
  private average = 0;
  private since = 0;
  private changedAt = 0;
  readonly scales = [1, 0.8, 0.6] as const;
  get scale() {
    return this.scales[this.level];
  }
  observe(costMs: number, now: number, frameBudgetMs: number): boolean {
    if (
      !Number.isFinite(costMs) ||
      costMs < 0 ||
      !Number.isFinite(now) ||
      !Number.isFinite(frameBudgetMs) ||
      !(frameBudgetMs > 0)
    )
      return false;
    this.average = this.average ? this.average * 0.94 + costMs * 0.06 : costMs;
    const overloaded = this.average > frameBudgetMs * 0.8;
    const comfortable = this.average < frameBudgetMs * 0.35;
    if (!overloaded && !comfortable) {
      this.since = now;
      return false;
    }
    if (!this.since) this.since = now;
    if (now - this.changedAt < 2500) return false;
    const wait = overloaded ? 1200 : 8000;
    if (now - this.since < wait) return false;
    const next = Math.max(0, Math.min(this.scales.length - 1, this.level + (overloaded ? 1 : -1)));
    this.since = now;
    if (next === this.level) return false;
    this.level = next;
    this.changedAt = now;
    this.average = 0;
    return true;
  }
}
