/**
 * Bench marks for the Android measurements of Mention's builds (Bloom's ADR 0002, section 7):
 * with `EXPO_PUBLIC_BLOOM_BENCH=1` at bundle time, the first time each named moment happens it is
 * logged as `BLOOM_BENCH <name>`, which the bench times from the launch in logcat. Without the
 * flag the bundle inlines `undefined` and this does nothing.
 */
const seen = new Set<string>();

export function benchMark(name: string): void {
  if (process.env.EXPO_PUBLIC_BLOOM_BENCH !== '1' || seen.has(name)) return;
  seen.add(name);
  console.log(`BLOOM_BENCH ${name}`);
}

/** Every time (not once): `BLOOM_BENCH <name>`, for marks that repeat (a like's tap and draw). */
export function benchLog(name: string): void {
  if (process.env.EXPO_PUBLIC_BLOOM_BENCH !== '1') return;
  console.log(`BLOOM_BENCH ${name}`);
}
