// DEV ONLY. The TypeScript PostLocation as it was before its migration (Mention #2049), the render check's reference.

import type { GeoJSONPoint } from '@mention/shared-types';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';

import { HStack, Icon, RawText } from '@oxy.so/bloom-language';

/**
 * A post's place: a pin and its address (or its coordinates when it has none) on one muted
 * line. Nothing when the point has no coordinates.
 */
export function postLocation(location: GeoJSONPoint) {
  if (!location?.coordinates?.[0] || !location?.coordinates?.[1]) {
    return null;
  }

  const longitude = location.coordinates[0];
  const latitude = location.coordinates[1];
  const displayText = location.address || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

  return HStack(
    Icon(RiMapPinLine).size('14').margin('right', 'xs').foreground('muted'),
    RawText(displayText).foreground('muted').font('sm').flex('1').lines(1),
  )
    .align('center')
    .padding('vertical', 'xs');
}
