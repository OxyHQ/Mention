import { EXPECTED_VIEWER_HEADER } from '@mention/shared-types/common';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { NextFunction, Response } from 'express';

/** A request intent only: the authenticated subject remains the sole authority. */
export function requireExpectedViewer(req: OxyAuthRequest, res: Response, next: NextFunction) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const headerCount = req.rawHeaders.filter(
    (_value, index) =>
      index % 2 === 0 &&
      req.rawHeaders[index]?.toLowerCase() === EXPECTED_VIEWER_HEADER.toLowerCase(),
  ).length;
  const expected = req.get(EXPECTED_VIEWER_HEADER);
  if (headerCount !== 1 || !expected || expected.trim() !== expected) {
    return res.status(400).json({ code: 'EXPECTED_VIEWER_REQUIRED' });
  }
  if (expected !== userId) return res.status(409).json({ code: 'VIEWER_CHANGED' });
  next();
}
