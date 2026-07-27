import { readFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';

const exceptionFile = new URL('../security-audit-exceptions.json', import.meta.url);
const parsed = JSON.parse(await readFile(exceptionFile, 'utf8'));
const exceptions = Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
const today = new Date();

for (const entry of exceptions) {
  for (const field of ['advisory', 'package', 'scope', 'reason', 'compensation', 'expires']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new Error(`Security audit exception is missing ${field}`);
    }
  }
  const expires = new Date(`${entry.expires}T23:59:59.999Z`);
  if (!Number.isFinite(expires.getTime()) || expires < today) {
    throw new Error(
      `Security audit exception ${entry.advisory} expired on ${entry.expires}`,
    );
  }
}

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
const ignoredAdvisories = new Set(exceptions.map((entry) => entry.advisory));
const blocking = [];

for (const [packageName, advisories] of Object.entries(payload)) {
  if (!Array.isArray(advisories)) continue;
  for (const advisory of advisories) {
    const severity = String(advisory?.severity ?? '').toLowerCase();
    const id = String(advisory?.url ?? '').split('/').pop() || String(advisory?.id ?? '');
    if (
      (severityRank.get(severity) ?? 0) >= severityRank.get('high') &&
      !ignoredAdvisories.has(id)
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
    console.error(
      `- ${issue.package} ${issue.advisory} (${issue.severity}): ${issue.title}`,
    );
  }
  process.exit(1);
}

console.log(
  `Security audit passed; ${exceptions.length} reviewed exception(s) remain within their expiry window.`,
);
