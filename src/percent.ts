/**
 * A fraction as a percentage, rounded down, so it never overstates progress or likeness: only 1 reads 100% and only 0
 * reads 0%. One decimal near either end (99.8%, 0.4%), whole numbers in between (42%), and more decimals for a value so
 * small that one decimal would still read 0 (0.08%). Values outside [0, 1] are clamped; NaN reads 0%.
 *
 * The fractions come from whole counts of at most a few million, so a true value below 1 is at least ~1e-7 below it;
 * the 1e-9 nudge only undoes float error such as 0.29 * 100 = 28.999999999999996.
 * The dashboard page imports this module too (src/web/app.ts; the server serves build/percent.js at /percent.js), so
 * it must stay free of Node imports.
 */
export function percentDown(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  if (fraction >= 1) return "100%";
  const whole = Math.floor(100 * fraction + 1e-9);
  for (let digits = whole < 10 || whole >= 90 ? 1 : 0; ; digits++) {
    const scale = 10 ** digits;
    const n = Math.floor(100 * scale * fraction + 1e-9);
    if (digits >= 6 || (n > 0 && n < 100 * scale)) return `${(n / scale).toFixed(digits)}%`;
  }
}
