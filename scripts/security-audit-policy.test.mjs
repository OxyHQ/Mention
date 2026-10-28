import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exceptionMatches, validateAuditException } from './security-audit-policy.mjs';

const policy = JSON.parse(
  readFileSync(new URL('../security-audit-exceptions.json', import.meta.url)),
);
const entry = policy.exceptions.find((item) => item.advisory === 'GHSA-mrhx-c7xc-m3w5');
const base = () => ({
  entry: structuredClone(entry),
  packageName: 'zod',
  advisory: {
    url: `https://github.com/advisories/${entry.advisory}`,
    vulnerable_versions: '<4.6.6',
  },
  packages: Object.fromEntries(
    Object.entries({
      ...entry.resolutionGuard.resolutions,
      ...entry.resolutionGuard.owners,
      zod: 'zod@4.6.7',
    }).map(([key, value]) => [key, [value]]),
  ),
  proof: 'Independent review of actual current call paths and residual risk.',
  today: new Date('2026-10-24T00:00:00Z'),
});

test('accepts only the reviewed vulnerable graph alongside patched Zod', () => {
  assert.equal(exceptionMatches(base()), true);
});
for (const [name, mutate] of [
  [
    'new vulnerable Zod 4 prerelease',
    (input) => {
      input.packages['new-package/zod'] = ['zod@4.6.5-beta.1'];
    },
  ],
  [
    'new vulnerable Zod 3 prerelease',
    (input) => {
      input.packages['new-package/zod'] = ['zod@3.26.0-beta.1'];
    },
  ],
  [
    'new vulnerable Zod 4 copy',
    (input) => {
      input.packages['new-package/zod'] = ['zod@4.4.3'];
    },
  ],
  [
    'new vulnerable Zod 3 path',
    (input) => {
      input.packages['new-package/zod'] = ['zod@3.25.76'];
    },
  ],
  [
    'changed vulnerable version',
    (input) => {
      input.packages['@expo/cli/zod'] = ['zod@3.25.75'];
    },
  ],
  [
    'changed owner',
    (input) => {
      input.packages['@expo/cli'] = ['@expo/cli@58.1.16'];
    },
  ],
  [
    'missing owner',
    (input) => {
      delete input.packages['@expo/cli'];
    },
  ],
  [
    'removed resolution requires retiring the review',
    (input) => {
      delete input.packages['@expo/cli/zod'];
    },
  ],
  [
    'new advisory range',
    (input) => {
      input.advisory.vulnerable_versions = '<4.6.7';
    },
  ],
  [
    'missing proof',
    (input) => {
      delete input.proof;
    },
  ],
  [
    'empty proof',
    (input) => {
      input.proof = ' ';
    },
  ],
  [
    'unmatched package',
    (input) => {
      input.packageName = 'body-parser';
    },
  ],
  [
    'unmatched advisory',
    (input) => {
      input.advisory.url = 'https://github.com/advisories/GHSA-other';
    },
  ],
  [
    'invalid installed version',
    (input) => {
      input.packages['@expo/cli/zod'] = ['zod@unknown'];
    },
  ],
])
  test(`rejects ${name}`, () => {
    const input = base();
    mutate(input);
    assert.equal(exceptionMatches(input), false);
  });

test('approved review expires immediately after November 4 UTC', () => {
  const input = base();
  assert.equal(input.entry.expires, '2026-11-04');
  input.today = new Date('2026-11-04T23:59:59.999Z');
  assert.equal(exceptionMatches(input), true);
  input.today = new Date('2026-11-05T00:00:00.000Z');
  assert.throws(() => exceptionMatches(input), /expired/);
});
test('deleting the Zod guard cannot turn it into a blanket exception', () => {
  const input = base();
  delete input.entry.resolutionGuard;
  assert.throws(() => exceptionMatches(input), /exact resolution guard/);
});
test('missing compensation is invalid', () => {
  const input = base();
  delete input.entry.compensation;
  assert.throws(() => exceptionMatches(input), /compensation/);
});
test('existing reviewed exceptions retain package, advisory and expiry checks', () => {
  const legacy = policy.exceptions[0];
  validateAuditException(legacy, new Date('2026-10-24'));
  assert.equal(
    exceptionMatches({
      entry: legacy,
      packageName: legacy.package,
      advisory: { url: `https://github.com/advisories/${legacy.advisory}` },
      today: new Date('2026-10-24'),
    }),
    true,
  );
  assert.equal(
    exceptionMatches({
      entry: legacy,
      packageName: 'unrelated',
      advisory: { url: `https://github.com/advisories/${legacy.advisory}` },
      today: new Date('2026-10-24'),
    }),
    false,
  );
});
