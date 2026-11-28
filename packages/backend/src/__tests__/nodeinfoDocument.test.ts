/**
 * NodeInfo 2.0 `usage` counts only this instance, and `software.version` comes
 * from the build's own version sources.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backendPackageVersion,
  readBackendPackageVersion,
  resolveMentionSoftwareVersion,
} from '../services/federation/mentionSoftwareVersion';
import {
  nodeinfoStatisticsExtension,
  nodeinfoUsage,
  type NodeinfoStatistics,
} from '../services/federation/nodeinfoStatistics';

const stats: NodeinfoStatistics = {
  measuredAt: Date.UTC(2026, 10, 28),
  local: { posts: 7, comments: 2, total: 9 },
  external: { posts: 3, comments: 1, total: 4 },
  combined: { posts: 10, comments: 3, total: 13 },
  externalActors: { count: 982_818, exact: false },
};

const users = {
  total: 35,
  exact: true,
  computedAt: '2026-11-28T00:38:05.128Z',
  stale: false,
};

describe('nodeinfoUsage', () => {
  it('counts registered accounts and local public posts, not remote actors', () => {
    expect(nodeinfoUsage(stats, users)).toEqual({
      users: { total: 35 },
      localPosts: 7,
      localComments: 2,
    });
    const extension = nodeinfoStatisticsExtension(stats, users);
    expect(extension.standardFields).toBe('local');
    expect(extension.version).toBe(4);
    expect(extension.externalActors).toEqual({ count: 982_818, exact: false });
    expect(extension.posts).toEqual({ local: 7, external: 3, combined: 10 });
  });

  it('omits a users total Oxy has not snapshotted, and does not invent active windows', () => {
    expect(nodeinfoUsage(stats, undefined)).toEqual({
      users: {},
      localPosts: 7,
      localComments: 2,
    });
    expect(nodeinfoUsage(undefined, users)).toEqual({ users: { total: 35 } });
    expect(nodeinfoUsage(undefined, undefined)).toEqual({ users: {} });
  });
});

describe('resolveMentionSoftwareVersion', () => {
  const packageVersion = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
    .version as string;

  it('prefers the managed deployment release over the image stamp and the package', () => {
    expect(
      resolveMentionSoftwareVersion({
        deploymentVersion: '2.4.1',
        releaseVersion: '0123456789abcdef0123456789abcdef01234567',
        packageVersion,
      }),
    ).toBe('2.4.1');
  });

  it('uses the image release stamp when this process has no deployment manifest', () => {
    expect(
      resolveMentionSoftwareVersion({
        deploymentVersion: '  ',
        releaseVersion: '0123456789abcdef0123456789abcdef01234567',
        packageVersion,
      }),
    ).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('reads @mention/backend package.json when nothing was stamped', () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(readBackendPackageVersion(__dirname)).toBe(packageVersion);
    // `dist/src/services/federation` is where tsc emits this module in the image.
    expect(readBackendPackageVersion(join(__dirname, '../../dist/src/services/federation'))).toBe(
      packageVersion,
    );
    expect(backendPackageVersion()).toBe(packageVersion);
    expect(
      resolveMentionSoftwareVersion({
        releaseVersion: '',
        packageVersion: '   ',
      }),
    ).toBe(packageVersion);
  });
});
