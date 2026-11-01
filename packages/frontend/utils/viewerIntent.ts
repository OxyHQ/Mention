import { EXPECTED_VIEWER_HEADER } from '@mention/shared-types/common';

/** Narrows a request to its intended subject; it does not authenticate one. */
export function viewerIntent(viewerId: string) {
  return { headers: { [EXPECTED_VIEWER_HEADER]: viewerId } };
}
