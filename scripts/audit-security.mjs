import { readFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { exceptionMatches, validateAuditException } from './security-audit-policy.mjs';

const exceptionFile = new URL('../security-audit-exceptions.json', import.meta.url);
const parsed = JSON.parse(await readFile(exceptionFile, 'utf8'));
const exceptions = Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
const today = new Date();

const proofByAdvisory = new Map();
for (const entry of exceptions) {
  validateAuditException(entry, today);
  if (entry.resolutionGuard) {
    const proofPath = entry.resolutionGuard.proof;
    if (
      typeof proofPath !== 'string' ||
      !proofPath.startsWith('docs/') ||
      proofPath.split('/').includes('..')
    )
      throw new Error('Guarded security audit exception requires a repository review document');
    proofByAdvisory.set(
      entry.advisory,
      await readFile(new URL(`../${proofPath}`, import.meta.url), 'utf8'),
    );
  }
}
const lockfile = Bun.JSONC.parse(await readFile(new URL('../bun.lock', import.meta.url), 'utf8'));

const child = Bun.spawn([process.execPath, 'audit', '--json'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdin: 'inherit',
  stdout: 'pipe',
  stderr: 'pipe',
});

const [stdoutBuffer, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).arrayBuffer(),
  new Response(child.stderr).text(),
  child.exited,
]);

const auditBytes = Buffer.from(stdoutBuffer);

function decompressAuditResponse(bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = createGunzip();
    gunzip.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', (error) => {
      // Bun 1.3.14 can expose the registry's complete JSON body while omitting
      // the gzip trailer. Accept that partial stream only when it is already a
      // complete JSON document; every other decompression error remains fatal.
      const partial = Buffer.concat(chunks);
      try {
        JSON.parse(partial.toString('utf8'));
        resolve(partial);
      } catch {
        reject(error);
      }
    });
    gunzip.end(bytes);
  });
}

async function parseAuditPayload(bytes) {
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const decoded = isGzip ? await decompressAuditResponse(bytes) : bytes;
  return JSON.parse(decoded.toString('utf8'));
}

let payload;
try {
  payload = await parseAuditPayload(auditBytes);
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw new Error(
    `Unable to parse Bun security audit response (exit ${exitCode}): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

const severityRank = new Map([
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);
const blocking = [];

for (const [packageName, advisories] of Object.entries(payload)) {
  if (!Array.isArray(advisories)) continue;
  for (const advisory of advisories) {
    const severity = String(advisory?.severity ?? '').toLowerCase();
    const id =
      String(advisory?.url ?? '')
        .split('/')
        .pop() || String(advisory?.id ?? '');
    if (
      (severityRank.get(severity) ?? 0) >= severityRank.get('high') &&
      !exceptions.some((entry) =>
        exceptionMatches({
          entry,
          packageName,
          advisory,
          packages: lockfile.packages,
          proof: proofByAdvisory.get(entry.advisory),
          today,
        }),
      )
    ) {
      blocking.push({
        package: packageName,
        advisory: id || 'unknown',
        severity,
        title: String(advisory?.title ?? 'Untitled advisory'),
      });
    }
  }
}

if (blocking.length > 0) {
  console.error('Reachable high/critical dependency advisories block this build:');
  for (const issue of blocking) {
    console.error(`- ${issue.package} ${issue.advisory} (${issue.severity}): ${issue.title}`);
  }
  process.exit(1);
}

console.log(
  `Security audit passed; ${exceptions.length} reviewed exception(s) remain within their expiry window.`,
);
