import { AGE_BANDS, type AgeBand } from '@oxy.so/contracts';

/**
 * The age band on the user Oxy returned for a session (oxy ADR 0067), or
 * `undefined` when there is none.
 *
 * Read defensively because the request user is whatever Oxy's validation
 * answered: only one of the three known bands counts. Anything else, including
 * a band a newer Oxy might add, reads as unknown, and unknown is never treated
 * as a minor or as an adult.
 */
export function ageBandOf(user: Record<string, unknown> | null | undefined): AgeBand | undefined {
  const band = user?.ageBand;
  return typeof band === 'string' && (AGE_BANDS as readonly string[]).includes(band)
    ? (band as AgeBand)
    : undefined;
}
