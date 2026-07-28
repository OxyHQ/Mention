import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Express calls route handlers with no receiver, so a controller METHOD
 * registered as `router.get('/:id', ctrl.method)` runs with `this === undefined`
 * and dies the moment it reaches `this.anything` — on the success path only,
 * which is what made `GET /polls/:id` return 500 in production while its
 * validation branches looked fine.
 *
 * Two ways to be safe, and this gate accepts either: register the handler bound
 * (`ctrl.method.bind(ctrl)`), or keep the controller free of `this` (helpers as
 * module functions). It fails only on the combination that breaks at runtime.
 */

const ROUTES = join(__dirname, '..', '..', 'routes');
const CONTROLLERS = join(__dirname, '..', '..', 'controllers');

/** `router.get('/x', somethingController.handler)` — the unbound form. */
const UNBOUND = /router\.(?:get|post|put|patch|delete|all)\([^)]*?\b([A-Za-z_$][\w$]*[Cc]ontroller)\.([\w$]+)\s*[,)]/g;

function routeFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(ROUTES, name));
}

function controllerSourceFor(routeSource: string, identifier: string): string | undefined {
  // `import pollsController from '../controllers/polls.controller'`
  const importLine = new RegExp(
    `import\\s+(?:\\*\\s+as\\s+)?${identifier}\\s+from\\s+'([^']+)'|import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*'([^']+)'`,
  ).exec(routeSource);
  const specifier = importLine?.[1] ?? importLine?.[2];
  if (!specifier) return undefined;
  const file = join(CONTROLLERS, `${specifier.split('/').pop()}.ts`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

describe('controller handlers registered without bind', () => {
  const files = routeFiles();

  // Vacuity floor: a broken traversal would otherwise report a clean sweep.
  it('scans the route files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never reach for `this`', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const [, identifier, method] of source.matchAll(UNBOUND)) {
        const controller = controllerSourceFor(source, identifier);
        if (!controller) continue;
        if (/\bthis\.[A-Za-z_$]/.test(controller)) {
          offenders.push(
            `${file.split('/').pop()}: ${identifier}.${method} is unbound, but ${identifier} uses \`this\``,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
