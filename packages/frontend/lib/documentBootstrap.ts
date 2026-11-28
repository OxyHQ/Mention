import type { User } from '@oxy.so/core';

/** Native documents carry no server bootstrap; see `documentBootstrap.web.ts`. */
export function bootstrapProfileFor(_handle: string): User | null {
  return null;
}
