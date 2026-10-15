/**
 * lazer's HitEventExtensions.CalculateUnstableRate: 10 × the (population)
 * standard deviation of the hit errors, each divided by the playback
 * rate so DT/HT report real-time consistency. Null without any hits.
 */
export function unstableRate(errors: readonly number[], rate = 1): number | null {
    const t = new UnstableRateTracker();
    return t.update(errors, rate);
}

/**
 * The same, kept up to date as hits are appended to a list (Welford's
 * online variance); a shorter list (a restart or a seek back) starts over.
 */
export class UnstableRateTracker {
    private count = 0;
    private mean = 0;
    private m2 = 0;
    private rate = 1;

    update(errors: readonly number[], rate = 1): number | null {
        if (errors.length < this.count || rate !== this.rate) {
            this.count = 0;
            this.mean = 0;
            this.m2 = 0;
            this.rate = rate;
        }
        for (let i = this.count; i < errors.length; i++) {
            const v = errors[i] / rate;
            this.count++;
            const delta = v - this.mean;
            this.mean += delta / this.count;
            this.m2 += delta * (v - this.mean);
        }
        return this.value;
    }

    get value(): number | null {
        return this.count > 0 ? Math.sqrt(this.m2 / this.count) * 10 : null;
    }
}
