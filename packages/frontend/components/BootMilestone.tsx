import { useEffect } from 'react';
import { recordBootMilestone, type BootMilestone as BootMilestoneName } from '@/lib/webTelemetry';

/**
 * Records a boot milestone when this element first commits. Placed where a
 * gate opens, so the milestone is the moment the gated tree actually mounted.
 * Renders nothing; a no-op on native.
 */
export function BootMilestone({ name }: { name: BootMilestoneName }) {
  useEffect(() => {
    recordBootMilestone(name);
  }, [name]);
  return null;
}
