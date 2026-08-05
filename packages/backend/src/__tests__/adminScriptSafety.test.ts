import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TypeScript from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_MUTATION_CONFIRMATION_ENV,
  assertAdminMutationAllowed,
} from '../scripts/lib/adminScriptSafety';

const ts = createRequire(path.join(__dirname, 'adminScriptSafety.test.ts'))(
  'typescript',
) as typeof TypeScript;
const SCRIPTS_DIRECTORY = path.resolve(__dirname, '../scripts');
const SCRIPT_NAME = 'purgeGoneFederatedActors';
const READ_ONLY_SCRIPTS = new Set([
  // Counts rows and exits. Its entire database surface is
  // `select count(*) from <table>` — no insert, update or delete — and it runs
  // before `update-service` precisely so it can refuse a rollout without ever
  // having changed anything.
  'assertPostgresPopulated.ts',
  'evalFeedQuality.ts',
  // Prints what a term's posts store; makes no write of any kind.
  'inspectTrendTerms.ts',
  // Re-derives one field from a pure function over data already on the post.
  // Idempotent, and the ingest path rewrites the same field anyway.
  'rebaselineTrendTerms.ts',
]);

/**
 * Scripts whose guard is not negotiable, named so the sweep below cannot pass by
 * finding nothing.
 *
 * `expect(unguarded).toEqual([])` is satisfied just as well by a `src/scripts`
 * that was emptied, renamed or moved as by one where every script is guarded —
 * `readdirSync` over a directory of no `.ts` files yields no candidates and no
 * offenders. These are the destructive ones; requiring that they are FOUND, and
 * found guarded, is a floor a broken traversal cannot meet.
 */
const REQUIRED_GUARDED_SCRIPTS = [
  'purgeBlockedDomainContent.ts',
  'purgeBlockedDomainPlatformData.ts',
];

/**
 * Whether a script CALLS the guard, decided on the AST.
 *
 * A substring search answers a narrower question than the one that matters: it
 * counts a mention inside a docblock — this branch documents replaced behaviour
 * everywhere — and it misses a call the formatter wrapped, since the old needle
 * `assertAdminMutationAllowed({` requires the brace on the same line.
 */
function callsAdminMutationGuard(script: string): boolean {
  const absolute = path.join(SCRIPTS_DIRECTORY, script);
  const sourceFile = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let called = false;
  const visit = (node: TypeScript.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'assertAdminMutationAllowed'
    ) {
      called = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return called;
}

describe('assertAdminMutationAllowed', () => {
  it('allows a dry run without confirmation', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: true,
        environment: { NODE_ENV: 'production' },
      }),
    ).not.toThrow();
  });

  it('rejects mutation even when NODE_ENV is missing or incorrect', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: { NODE_ENV: 'development' },
      }),
    ).toThrow(`CONFIRM_ADMIN_MUTATION=${SCRIPT_NAME}`);

    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {},
      }),
    ).toThrow('refusing a mutating administrative run');
  });

  it('rejects a mutation without exact confirmation', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: { NODE_ENV: 'production' },
      }),
    ).toThrow(`CONFIRM_ADMIN_MUTATION=${SCRIPT_NAME}`);

    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {
          NODE_ENV: 'production',
          [ADMIN_MUTATION_CONFIRMATION_ENV]: 'anotherScript',
        },
      }),
    ).toThrow('refusing a mutating administrative run');
  });

  it('allows a mutation only for the exact reviewed script', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {
          NODE_ENV: 'production',
          [ADMIN_MUTATION_CONFIRMATION_ENV]: SCRIPT_NAME,
        },
      }),
    ).not.toThrow();
  });

  it('guards every mutating top-level administrative script', () => {
    const scripts = readdirSync(SCRIPTS_DIRECTORY).filter((name) => name.endsWith('.ts'));
    const guarded = new Set(scripts.filter(callsAdminMutationGuard));
    const at = (name: string): string => `src/scripts/${name}`;

    // FLOOR — the traversal reached the real directory, and the scripts that
    // must never run unconfirmed are in it and guarded.
    expect(REQUIRED_GUARDED_SCRIPTS.filter((name) => !scripts.includes(name)).map(at)).toEqual([]);
    expect(REQUIRED_GUARDED_SCRIPTS.filter((name) => !guarded.has(name)).map(at)).toEqual([]);

    // FLOOR — the exemption list may not rot into excusing a name nothing in
    // that directory answers to, which is how a real script inherits an
    // exemption written for a different one.
    expect([...READ_ONLY_SCRIPTS].filter((name) => !scripts.includes(name)).map(at)).toEqual([]);

    const unguarded = scripts
      .filter((name) => !READ_ONLY_SCRIPTS.has(name) && !guarded.has(name))
      .map(at);
    expect(unguarded).toEqual([]);
  });
});
