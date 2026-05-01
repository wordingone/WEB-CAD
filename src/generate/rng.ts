/**
 * Tiny deterministic PRNG (mulberry32). Same seed => same sequence.
 * Used by the synthetic generator so v2 rows are reproducible.
 */

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Uniform float in [lo, hi]. */
  float(lo: number, hi: number, decimals = 2): number {
    const x = lo + this.next() * (hi - lo);
    const f = Math.pow(10, decimals);
    return Math.round(x * f) / f;
  }

  /** Log-uniform float in [lo, hi]. */
  logFloat(lo: number, hi: number, decimals = 2): number {
    const x = Math.exp(Math.log(lo) + this.next() * (Math.log(hi) - Math.log(lo)));
    const f = Math.pow(10, decimals);
    return Math.round(x * f) / f;
  }

  /** Uniform pick from array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Bernoulli(p). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}
