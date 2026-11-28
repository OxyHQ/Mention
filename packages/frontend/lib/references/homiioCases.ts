import type { PublicCase } from '@oxy.so/homiio-sdk/client';
import { VisibleReferenceStore } from './VisibleReferenceStore';

/**
 * No provider fetch or SDK initialization runs during feed hydration or import.
 * The `client` entry checks responses without Zod, so cards add no second way
 * for zod into the app (see `lib/notificationValidation`).
 */
export const homiioCases = new VisibleReferenceStore<PublicCase>(async (ids, options) => {
  const { HomiioClient } = await import('@oxy.so/homiio-sdk/client');
  return new HomiioClient().getPublicCases(ids, options);
});
