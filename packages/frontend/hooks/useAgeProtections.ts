import { useMemo } from 'react';
import { type AgeProtections, protectionsFor } from '@oxy.so/contracts/client';
import { useAuth } from '@oxy.so/services/ui/client';

/**
 * The protective defaults for the signed-in account (oxy ADR 0068), from the
 * age band on its own profile: a minor's are a feed loaded on request and no
 * autoplay. An adult, an account of unknown age and a signed-out reader get the
 * standard profile.
 *
 * This shapes what the app OFFERS. What a minor is served is decided again on
 * the server from the same band, so a client that ignored this hook would
 * still get no ranked feed and no push at night.
 */
export function useAgeProtections(): AgeProtections {
  const { user } = useAuth();
  const ageBand = user?.ageBand;
  return useMemo(() => protectionsFor(ageBand), [ageBand]);
}
