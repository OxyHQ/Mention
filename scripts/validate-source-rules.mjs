#!/usr/bin/env bun
// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Enforces the source rules that `docs/frontend-rules.md` and the backend
 * conventions state in prose and nothing else checked.
 *
 * Each rule is one entry in `RULES`: where it applies, and a function that
 * reads a parsed file and returns the offending nodes. Matching is done on the
 * TypeScript AST, so a rule that is only mentioned in a comment (the places that
 * explain WHY the rule exists) never fires, and every syntactic form of the
 * thing a rule forbids is covered: static import, `import()`, `require()`.
 *
 * Rules, and the sentence of the docs each one turns into a check:
 *
 * - `backend-console`: "Use the logger": a stray `console.log` in the API
 *   bypasses pino's redaction and its structured output. `console.warn` and
 *   `console.error` stay allowed; `runtime/globalErrorHandlers.ts` uses them
 *   deliberately before the logger can be trusted. Operator CLIs under
 *   `src/scripts/` print to a terminal on purpose and are out of scope.
 * - `no-react-virtual`: "Do not add an app-local virtualizer"; lists are
 *   Bloom's `VirtualList` (a direct `@tanstack/react-virtual` caller freezes
 *   under the React Compiler, see `frontend-compiler-notes.md`).
 * - `hls-single-import`: "a second `import('hls.js')` anywhere in the app would
 *   silently make the demuxer ..." (`lib/hlsPlayback.web.ts`): the one dynamic
 *   import is the only one, and nothing imports the package statically.
 * - `no-can-play-type`: HLS support is gated on `isTypeSupported`, never on
 *   `canPlayType`, which answers "maybe" for streams the element cannot play.
 * - `no-router-singleton`: "Use `useRouter()`, never the global `router`
 *   singleton in reusable screens": the singleton ignores the Deck panel router.
 * - `no-viewport-height-literal`: "Do not use `100vh`": it adds the classic
 *   scrollbar height back into the Deck host.
 *
 * Not covered here on purpose: the `@mention/shared-types` root-versus-subpath
 * rule. Whether an imported name is a runtime value or a type is a question for
 * the type checker, and a syntactic version would flag every type-only import
 * written without `type`. `sharedTypesEntryIsolation.test.ts` checks the bundle.
 *
 * Gate-writing rules this follows: a vacuity floor per rule (a traversal that
 * silently stops finding files would otherwise report clean forever), comments
 * stripped by construction, and a mutation self-test
 * (`test-validate-source-rules.mjs`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Overridable so the self-test can point the real validator at a scratch tree. */
const repositoryRoot = process.env.SOURCE_RULES_ROOT
  ? resolve(process.env.SOURCE_RULES_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = /\.(?:tsx?|mts|cts)$/;
const ALWAYS_EXCLUDED = /(?:^|\/)(?:node_modules|dist|build|\.expo|android|ios|__mocks__)(?:\/|$)/;
const TEST_OR_HARNESS =
  /(?:^|\/)(?:__tests__|__perf__|test-support)(?:\/|$)|\.(?:test|spec|perf)\.[cm]?[jt]sx?$/;

const FRONTEND = 'packages/frontend';
const BACKEND_SRC = 'packages/backend/src';

/** Stringified module specifier of an import/export/require/import() node, or null. */
function moduleSpecifierOf(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    return node.arguments[0].text;
  }
  return null;
}

/** True for `import type …` and `export type …`, which erase at build time. */
function isTypeOnlyDeclaration(node) {
  if (ts.isImportDeclaration(node)) return node.importClause?.isTypeOnly === true;
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  return false;
}

function walk(source, visit) {
  const recurse = (node) => {
    visit(node);
    ts.forEachChild(node, recurse);
  };
  recurse(source);
}

/** Collect every node of `source` for which `match` returns a description. */
function collect(source, match) {
  const hits = [];
  walk(source, (node) => {
    const description = match(node);
    if (description) hits.push({ node, description });
  });
  return hits;
}

const RULES = [
  {
    id: 'backend-console',
    roots: [BACKEND_SRC],
    exclude: (path) => path.startsWith(`${BACKEND_SRC}/scripts/`),
    minimumFiles: 400,
    check: (source) =>
      collect(source, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'console' &&
          ['log', 'debug', 'info'].includes(node.expression.name.text)
        ) {
          return `console.${node.expression.name.text}() in API code: use the logger (utils/logger.ts)`;
        }
        return null;
      }),
  },
  {
    id: 'no-react-virtual',
    roots: [FRONTEND],
    minimumFiles: 800,
    check: (source) =>
      collect(source, (node) =>
        moduleSpecifierOf(node) === '@tanstack/react-virtual'
          ? 'app-local virtualizer: use Bloom VirtualList (a missing capability goes into Bloom)'
          : null,
      ),
  },
  {
    id: 'hls-single-import',
    roots: [FRONTEND],
    minimumFiles: 800,
    check: (source, path) =>
      collect(source, (node) => {
        if (moduleSpecifierOf(node) !== 'hls.js') return null;
        if (isTypeOnlyDeclaration(node)) return null;
        const isDynamicImport =
          ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isDynamicImport && path === `${FRONTEND}/lib/hlsPlayback.web.ts`) return null;
        return "hls.js must be loaded only by the one import('hls.js') in lib/hlsPlayback.web.ts";
      }),
    /** The single allowed site must still exist, or the rule is checking nothing. */
    floor: (files) => {
      const site = `${FRONTEND}/lib/hlsPlayback.web.ts`;
      return files.has(site) ? null : `${site} is missing: the hls.js rule has no anchor`;
    },
  },
  {
    id: 'no-can-play-type',
    roots: [FRONTEND],
    minimumFiles: 800,
    check: (source) =>
      collect(source, (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'canPlayType'
          ? 'canPlayType() answers "maybe" for streams the element cannot play: gate on isTypeSupported'
          : null,
      ),
  },
  {
    id: 'no-router-singleton',
    roots: [FRONTEND],
    minimumFiles: 800,
    check: (source) =>
      collect(source, (node) => {
        if (
          !ts.isImportDeclaration(node) ||
          node.importClause?.isTypeOnly ||
          moduleSpecifierOf(node) !== 'expo-router'
        ) {
          return null;
        }
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return null;
        const imported = bindings.elements.some(
          (element) =>
            !element.isTypeOnly && (element.propertyName ?? element.name).text === 'router',
        );
        return imported
          ? 'global router singleton: use useRouter() (it follows the Deck panel router)'
          : null;
      }),
  },
  {
    id: 'no-viewport-height-literal',
    roots: [FRONTEND],
    minimumFiles: 800,
    check: (source) =>
      collect(source, (node) =>
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /\b100vh\b/.test(node.text)
          ? '100vh adds the scrollbar height back into the Deck host: use 100% or 100dvh with a bounded parent'
          : null,
      ),
  },
];

async function collectFiles(directory, collected) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(repositoryRoot, path).split('\\').join('/');
    if (ALWAYS_EXCLUDED.test(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectFiles(path, collected);
    } else if (SOURCE_EXTENSIONS.test(entry.name) && !TEST_OR_HARNESS.test(relativePath)) {
      collected.push(relativePath);
    }
  }
  return collected;
}

const failures = [];
const filesByRoot = new Map();
const parsed = new Map();

async function parse(path) {
  let source = parsed.get(path);
  if (!source) {
    const contents = await readFile(resolve(repositoryRoot, path), 'utf8');
    source = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(path, source);
  }
  return source;
}

for (const rule of RULES) {
  const scanned = new Set();
  for (const root of rule.roots) {
    if (!filesByRoot.has(root)) {
      filesByRoot.set(root, await collectFiles(resolve(repositoryRoot, root), []));
    }
    for (const path of filesByRoot.get(root)) {
      if (!rule.exclude?.(path)) scanned.add(path);
    }
  }

  if (scanned.size < rule.minimumFiles) {
    failures.push(
      `[${rule.id}] scanned ${scanned.size} files, expected at least ${rule.minimumFiles}: the traversal is broken or the tree moved`,
    );
    continue;
  }
  const floorProblem = rule.floor?.(scanned);
  if (floorProblem) failures.push(`[${rule.id}] ${floorProblem}`);

  for (const path of scanned) {
    const source = await parse(path);
    for (const { node, description } of rule.check(source, path)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`[${rule.id}] ${path}:${line + 1}  ${description}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`validate-source-rules: ${failures.length} violation(s)\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `validate-source-rules: ${RULES.length} rules clean (${[...filesByRoot.values()].reduce((total, files) => total + files.length, 0)} files scanned)`,
);
