/**
 * Mongo is not reachable from the web task's boot path — asserted on the module
 * GRAPH, not on a grep.
 *
 * The property this defends was true by accident and is now depended on: no
 * runtime read or write goes to Mongo, so `server.ts` no longer opens a
 * connection to it and `/health/ready` no longer gates on one. Nothing about
 * that survives a single `import mongoose` added to a controller — the process
 * would start dialling a database nobody decommissioned yet, and the failure
 * would surface as slow boots or a readiness flap rather than as an import.
 *
 * ## Why a graph walk rather than a grep
 *
 * A grep for `mongoose` over `src/` answers a much broader question than the one
 * that matters and would fail today: ~60 model files, the migration runner, the
 * restore tooling and a dozen scripts all import it legitimately, and every one
 * of them is fine because nothing the SERVER loads reaches them. The question is
 * reachability from one entry point, so the check has to be reachability.
 *
 * ## Three things the walk has to get right, each learned from a real shape
 *
 *  - **`require()` with a string literal counts.** The import this gate replaces
 *    was `require("./src/models/Post")` inside a `db.once("open")` handler —
 *    invisible to any scanner that only reads `import` declarations, and it is
 *    exactly the shape a future one will take, because `server.ts` lazily
 *    `require`s most of its schedulers.
 *  - **`import type` does NOT count.** `db/feeds/customFeedRepository.ts` and
 *    `routes/customFeedWrite.ts` both name a type from `models/CustomFeed`, and
 *    both are erased at compile time — no module is loaded and no connection is
 *    made. Counting them would make this gate red on arrival and it would be
 *    wrong. Type-only named specifiers (`import { type X }`) are erased the same
 *    way and are excluded per specifier, not per statement.
 *  - **The floor.** `expect(offenders).toEqual([])` passes just as happily when
 *    the traversal breaks and visits nothing. {@link REQUIRED_REACHABLE} names
 *    modules the boot path certainly loads, so a walk that resolves nothing
 *    fails on the floor instead of reporting success.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TypeScript from 'typescript';
import { describe, expect, it } from 'vitest';

const ts = createRequire(path.join(__dirname, 'mongoOffTheBootPath.test.ts'))(
  'typescript',
) as typeof TypeScript;

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const BOOT_ENTRY = path.join(BACKEND_ROOT, 'server.ts');

/** The packages a web task must never load. */
const FORBIDDEN_PACKAGES = new Set(['mongoose', 'mongodb']);

/**
 * Modules the boot path certainly reaches, so a traversal that silently resolves
 * nothing cannot pass. Deliberately spread across the graph's depth: the express
 * app, a route module, and a service the feed depends on.
 */
const REQUIRED_REACHABLE = [
  'src/app.ts',
  'src/appRoutes.ts',
  'src/routes/health.routes.ts',
  'src/services/PostHydrationService.ts',
];

/** A module reached from the boot entry, with the chain that reached it. */
interface Reached {
  readonly file: string;
  readonly chain: readonly string[];
}

/** Resolve a relative specifier to a real `.ts` file, or `undefined`. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every specifier `file` loads AT RUNTIME: `import` declarations that are not
 * type-only, `export ... from`, and `require('literal')` calls.
 *
 * A statement whose every named specifier is `type`-marked is erased entirely,
 * so it is not a runtime load either — checked per specifier rather than
 * assuming `importClause.isTypeOnly` covers it.
 */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];

  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      // `import './x'` for side effects has no clause and IS a runtime load.
      const typeOnlyStatement = clause?.isTypeOnly === true;
      const bindings = clause?.namedBindings;
      const everyNamedIsType =
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        clause?.name === undefined &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!typeOnlyStatement && !everyNamedIsType) {
        specifiers.push(node.moduleSpecifier.text);
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      node.expression.getText(source) === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as TypeScript.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

/** Walk the runtime module graph from the boot entry. */
function walkBootGraph(): { reached: Map<string, Reached>; offenders: string[] } {
  const reached = new Map<string, Reached>();
  const offenders: string[] = [];
  const queue: Reached[] = [{ file: BOOT_ENTRY, chain: ['server.ts'] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reached.has(current.file)) continue;
    reached.set(current.file, current);

    for (const specifier of runtimeSpecifiers(current.file)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(current.file, specifier);
        if (resolved && !reached.has(resolved)) {
          queue.push({
            file: resolved,
            chain: [...current.chain, path.relative(BACKEND_ROOT, resolved)],
          });
        }
        continue;
      }
      // A bare specifier is a package. Only the forbidden ones are interesting;
      // the walk does not descend into `node_modules`.
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (FORBIDDEN_PACKAGES.has(packageName)) {
        offenders.push(`${packageName} <- ${current.chain.join(' -> ')}`);
      }
    }
  }

  return { reached, offenders };
}

describe('the web task boot path does not reach Mongo', () => {
  const { reached, offenders } = walkBootGraph();

  /**
   * The floor, asserted FIRST so a broken traversal reports itself rather than
   * being reported as a clean result by the check below.
   */
  it('reaches the modules the server certainly loads', () => {
    const relative = new Set(
      [...reached.keys()].map((file) => path.relative(BACKEND_ROOT, file)),
    );
    for (const required of REQUIRED_REACHABLE) {
      expect(relative.has(required), `${required} was not reached — the walk is broken`).toBe(true);
    }
    // A boot graph this small would mean resolution silently failed.
    expect(reached.size).toBeGreaterThan(100);
  });

  /**
   * THE case. Each offender is reported with the chain that reached it, because
   * "mongoose is on the boot path" is not actionable and
   * "server.ts -> src/app.ts -> ... -> src/models/Post.ts" is.
   *
   * Mutation: restore `require("./src/models/Post")` to `server.ts` and this
   * goes red naming that chain — verified, including through the `require`,
   * which is the form the deleted import actually took.
   */
  it('loads neither mongoose nor the mongodb driver, by any route', () => {
    expect(offenders).toEqual([]);
  });
});
