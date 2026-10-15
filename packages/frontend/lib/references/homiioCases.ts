import type { PublicCase } from '@oxy.so/homiio-sdk';
import { VisibleReferenceStore } from './VisibleReferenceStore';

/** No provider fetch or SDK initialization runs during feed hydration or import. */
export const homiioCases = new VisibleReferenceStore<PublicCase>(async (ids, options) => {
  const { HomiioClient } = await import('@oxy.so/homiio-sdk');
  return new HomiioClient().getPublicCases(ids, options);
});
