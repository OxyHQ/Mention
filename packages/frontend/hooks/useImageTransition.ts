import { usePrefersReducedMotion } from '@oxy.so/bloom/hooks';

/** An image's cross-fade in milliseconds: none for a viewer who asked for less motion. */
export function useImageTransition(duration: number): number {
  return usePrefersReducedMotion() ? 0 : duration;
}
