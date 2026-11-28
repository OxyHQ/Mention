import semver from 'semver';

const GUARDED_ZOD_ADVISORY = 'GHSA-mrhx-c7xc-m3w5';

/** Existing exceptions remain time-bound; Zod additionally pins the reviewed graph. */
export function validateAuditException(entry, today = new Date()) {
  for (const field of ['advisory', 'package', 'scope', 'reason', 'compensation', 'expires']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '')
      throw new Error(`Security audit exception is missing ${field}`);
  }
  const expires = new Date(`${entry.expires}T23:59:59.999Z`);
  if (!Number.isFinite(expires.getTime()) || expires < today)
    throw new Error(`Security audit exception ${entry.advisory} expired on ${entry.expires}`);
  if (entry.advisory === GUARDED_ZOD_ADVISORY && !entry.resolutionGuard)
    throw new Error('The Zod review requires an exact resolution guard');
}

/** Never interpret package-level advisory data as proof of a reviewed installation. */
export function exceptionMatches({ entry, packageName, advisory, packages, proof, today }) {
  validateAuditException(entry, today);
  const advisoryId =
    String(advisory?.url ?? '')
      .split('/')
      .pop() || String(advisory?.id ?? '');
  if (entry.package !== packageName || entry.advisory !== advisoryId) return false;
  const guard = entry.resolutionGuard;
  if (!guard) return true;
  if (
    !guard.vulnerableRange ||
    !semver.validRange(guard.vulnerableRange) ||
    advisory.vulnerable_versions !== guard.vulnerableRange ||
    typeof proof !== 'string' ||
    !proof.trim() ||
    !packages ||
    !guard.resolutions ||
    !guard.owners ||
    !Object.keys(guard.resolutions).length ||
    !Object.keys(guard.owners).length
  )
    return false;

  const vulnerable = {};
  for (const [path, resolution] of Object.entries(packages)) {
    const descriptor = resolution?.[0];
    if (typeof descriptor !== 'string') return false;
    const prefix = `${packageName}@`;
    if (!descriptor.startsWith(prefix)) continue;
    const version = descriptor.slice(prefix.length);
    if (!semver.valid(version)) return false;
    if (semver.satisfies(version, guard.vulnerableRange, { includePrerelease: true }))
      vulnerable[path] = descriptor;
  }
  const paths = Object.keys(vulnerable).sort();
  const expected = Object.keys(guard.resolutions).sort();
  if (paths.length !== expected.length) return false;
  if (
    paths.some(
      (path, index) => path !== expected[index] || vulnerable[path] !== guard.resolutions[path],
    )
  )
    return false;
  for (const [path, descriptor] of Object.entries(guard.owners)) {
    if (packages[path]?.[0] !== descriptor) return false;
  }
  // Every reviewed nested dependency must name its immediate consumer too.
  return paths.every((path) => {
    const suffix = `/${packageName}`;
    return path.endsWith(suffix) && path.slice(0, -suffix.length) in guard.owners;
  });
}
