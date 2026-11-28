/**
 * `software.version` on `GET /nodeinfo/2.0`.
 *
 * A running Mention build is already named in three places. This follows that
 * order instead of a literal:
 *
 * 1. A managed deployment's `release.version` (semver on the instance manifest).
 * 2. `MENTION_RELEASE_VERSION`, stamped into the backend image from the deploy's
 *    `DEPLOY_SHA` — the same revision as the image tag and
 *    `org.opencontainers.image.revision`.
 * 3. `@mention/backend`'s own `package.json` version, when neither is set
 *    (local and one-shot images that were not stamped).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BACKEND_PACKAGE_NAME = '@mention/backend';

/** Walk up from a source or `dist/` file to `@mention/backend`'s manifest. */
export function readBackendPackageVersion(startDirectory = __dirname): string {
  let directory = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === BACKEND_PACKAGE_NAME &&
        typeof parsed.version === 'string' &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // Not this directory, or not a package manifest. Keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`${BACKEND_PACKAGE_NAME} package.json version was not found`);
}

let cachedPackageVersion: string | undefined;

export function backendPackageVersion(): string {
  cachedPackageVersion ??= readBackendPackageVersion();
  return cachedPackageVersion;
}

export function resolveMentionSoftwareVersion(input: {
  /** Managed deployment `release.version`, when this process has a manifest. */
  deploymentVersion?: string;
  /** `MENTION_RELEASE_VERSION` from the image, usually the git SHA. */
  releaseVersion?: string;
  /** Test seam. Production reads `@mention/backend`'s manifest. */
  packageVersion?: string;
}): string {
  const deployment = input.deploymentVersion?.trim();
  if (deployment) return deployment;
  const release = input.releaseVersion?.trim();
  if (release) return release;
  const fromPackage = input.packageVersion?.trim();
  if (fromPackage) return fromPackage;
  return backendPackageVersion();
}
