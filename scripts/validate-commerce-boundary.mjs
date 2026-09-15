#!/usr/bin/env bun

/**
 * Mention is a Mercaria CONSUMER, and it reaches Mercaria only through
 * `@mercaria.co/sdk` (#951, Mercaria#1017):
 *
 *     Mention -> @mercaria.co/sdk -> Mercaria's public API
 *
 * The SDK owns the transport — the hosts, the `/public/v1` routes, the wire
 * envelope, the DTOs and the canonical links. A Mercaria hostname or a
 * public-API path written into Mention's production source is the first line of
 * a second, Mention-local client, so this fails on either, anywhere except the
 * one module allowed to configure the SDK client.
 *
 * WHAT IS SCANNED, AND WHY IT IS THE AST AND NOT THE TEXT
 *
 * Only the places a URL can actually be spelled: string literals, template
 * literal pieces (with or without substitutions), regular-expression literals
 * and JSX text. Comments are NOT scanned — the files that consume the SDK
 * explain the rule in prose next to the code, and a text grep over them would
 * trip on its own explanation. The cost is accepted and named: a host assembled
 * from fragments (`'mercaria' + '.co'`) is invisible here, as it is to any
 * scanner.
 *
 * `@mercaria.co/sdk` — the package's own name — is the one spelling of the host
 * that is ALLOWED, and it is a string literal in every file that imports the
 * SDK. A host match therefore refuses a preceding `@`. The run also asserts it
 * SAW that import at least once, so a literal walk that silently stopped reading
 * files cannot report clean.
 *
 * POPULATION
 *
 * Every tracked or untracked-but-not-ignored JS/TS source file under
 * `packages/<name>/`, minus tests, mocks, fixtures and build output, minus
 * `packages/e2e` (a test package). Derived from `git ls-files`, never from a
 * hand list, with a per-package floor so a shrunken corpus fails instead of
 * reading as clean.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = process.env.COMMERCE_BOUNDARY_ROOT
  ? resolve(process.env.COMMERCE_BOUNDARY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureMode = process.env.COMMERCE_BOUNDARY_FIXTURE === '1';

/**
 * The only production file that may name a Mercaria host or public-API path.
 * It needs neither today — an unset override means the SDK's own origins — but
 * if an origin ever has to be spelled out, this is where. It must exist: an
 * exemption for a file that is gone is a permission nobody re-examines.
 */
const EXEMPT_FILES = ['packages/backend/src/services/commerce/mercariaClient.ts'];

const EXCLUDED_PACKAGES = new Set(['e2e']);
const SOURCE_EXTENSION = /\.(?:tsx|ts|jsx|js|mjs|cjs)$/;
const NON_PRODUCTION = /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|dist|coverage|node_modules)(?:\/|$)|\.(?:test|spec)\.(?:tsx|ts|jsx|js|mjs|cjs)$|(?:^|\/)test-[^/]*\.(?:tsx|ts|jsx|js|mjs|cjs)$/;

/** Minimum production files per package; measured at landing, set a little under. */
const PACKAGE_FLOORS = fixtureMode
  ? {}
  : { backend: 500, frontend: 650, mcp: 30, 'shared-types': 30 };

const SDK_PACKAGE_LITERAL = '@mercaria.co/sdk';

const RULES = [
  {
    label: 'Mercaria host',
    // Any `mercaria.co` hostname (apex or subdomain), never `@mercaria.co/...`
    // (the SDK package) and never a longer TLD (`mercaria.com`).
    pattern: /(?<![@\w-])(?:[a-z0-9-]+\.)*mercaria\.co(?![a-z0-9-])/i,
  },
  {
    label: 'Mercaria public API path',
    pattern: /(?:^|\/)public\/v1(?![\w-])/,
  },
];

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Every piece of source text a URL could be written in, with its line. */
function literalsOf(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const found = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isRegularExpressionLiteral(node)
      || ts.isJsxText(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      // Backslashes are dropped before matching: a pattern that recognises the
      // host escapes its dots and slashes (`/mercaria\.co\//`, or the same
      // inside a string handed to `new RegExp`), and is still the host.
      found.push({ value: node.text, matchable: node.text.replace(/\\/g, ''), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const listed = Bun.spawnSync({
  cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages'],
  cwd: repositoryRoot,
  stdout: 'pipe',
  stderr: 'pipe',
});
if (listed.exitCode !== 0) {
  throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
}

const failures = [];
const sourceFiles = listed.stdout
  .toString()
  .split('\n')
  .filter((file) => /^packages\/[^/]+\//.test(file))
  .filter((file) => !EXCLUDED_PACKAGES.has(file.split('/')[1]))
  .filter((file) => SOURCE_EXTENSION.test(file) && !NON_PRODUCTION.test(file))
  .filter((file) => {
    if (existsSync(resolve(repositoryRoot, file))) return true;
    failures.push(`${file}: listed by git but missing from the working tree`);
    return false;
  });

const perPackage = new Map();
for (const file of sourceFiles) {
  const name = file.split('/')[1];
  perPackage.set(name, (perPackage.get(name) ?? 0) + 1);
}
if (sourceFiles.length === 0) failures.push('production source listing is empty');
for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
  const count = perPackage.get(name) ?? 0;
  if (count < floor) failures.push(`packages/${name}: production source listing is unexpectedly small (${count} < ${floor})`);
}

for (const exempt of EXEMPT_FILES) {
  if (!sourceFiles.includes(exempt)) {
    failures.push(`${exempt}: exempt from the commerce boundary but not a production source file; delete the exemption`);
  }
}

let literalCount = 0;
let sdkImportLiterals = 0;
for (const file of sourceFiles) {
  const text = await readFile(resolve(repositoryRoot, file), 'utf8');
  const literals = literalsOf(file, text);
  literalCount += literals.length;
  sdkImportLiterals += literals.filter(({ value }) => value === SDK_PACKAGE_LITERAL).length;
  if (EXEMPT_FILES.includes(file)) continue;
  for (const { matchable, line } of literals) {
    for (const { label, pattern } of RULES) {
      if (pattern.test(matchable)) failures.push(`${file}:${line}: ${label} outside the SDK (use @mercaria.co/sdk)`);
    }
  }
}

// The positive control: the SDK is consumed, so its package name must have been
// SEEN as a literal. Zero means the walk read nothing that matters.
if (sdkImportLiterals === 0) {
  failures.push(`no "${SDK_PACKAGE_LITERAL}" literal was seen; the scan cannot be reading the SDK's consumers`);
}

if (failures.length > 0) {
  console.error(`Commerce boundary validation failed:\n\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

const breakdown = [...perPackage.entries()].sort().map(([name, count]) => `${name} ${count}`).join(', ');
console.log(
  `Validated Mention's Mercaria boundary: ${sourceFiles.length} production source files (${breakdown}), `
  + `${literalCount} literals, ${sdkImportLiterals} @mercaria.co/sdk import(s) seen.`,
);
