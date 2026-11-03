/**
 * prifly lets an extension have one `api.llm.ask` in flight and 60 an hour.
 * The grouping call and the summary-line batches share one `AskLimits`, so no
 * two asks run at once and the hour's count has a margin.
 */

const HOUR_MS = 3_600_000;
/** Line batches stop here: the grouping and its retry keep the rest of prifly's 60. */
export const LINES_BUDGET = 40;

export class AskLimits {
  private flying = false;
  private times: number[] = [];

  /** Whether an ask is running. */
  get busy(): boolean {
    return this.flying;
  }

  /** Asks made in the hour up to `now`. */
  used(now: number): number {
    this.times = this.times.filter((at) => now - at < HOUR_MS);
    return this.times.length;
  }

  /** Take the one place for an ask; false when it is taken. */
  begin(): boolean {
    if (this.flying) return false;
    this.flying = true;
    return true;
  }

  end(): void {
    this.flying = false;
  }

  /** Count an ask made at `now`. */
  record(now: number): void {
    this.times.push(now);
  }
}
