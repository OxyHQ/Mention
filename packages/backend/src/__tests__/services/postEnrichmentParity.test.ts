import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE class regression guard: post-ingest enrichment cannot be wired into one
 * storage route and forgotten on the other.
 *
 * A post reaches the database by two structurally different routes — the shared
 * `PostCreationService`, and the ActivityPub outbox backfill's raw
 * `Post.collection.insertMany`, which bypasses that service deliberately. When
 * the enrichment fan-out lived at those call sites, each new enrichment was a
 * fresh chance to remember one route and forget the other, and that is exactly
 * what happened: media metadata was added natively and missed on the backfill;
 * link previews were then missed the same way; scheduled posts were missed on
 * both. Three omissions, one cause.
 *
 * The fix was structural — `services/postEnrichment/` owns the fan-out, every
 * route calls `enrichIngestedPosts` — so the guard is structural too. It is
 * SELF-EXTENDING: it derives the enrichment set from the directory rather than
 * from a list written here, so a step added tomorrow is covered without anyone
 * remembering to update this file.
 *
 * KNOWN LIMIT, stated rather than papered over: this catches a new enrichment
 * that lives in the enrichment directory (where the module docs send you) being
 * bypassed or half-wired. It cannot detect an arbitrary new side effect someone
 * writes into `PostCreationService` from an unrelated module and never adds
 * here — no static check can. What it does guarantee is that the convergence
 * point exists, is complete, and is the only enrichment surface the ingest
 * routes are allowed to touch.
 */

const BACKEND_SRC = join(__dirname, '..', '..');
const ENRICHMENT_DIR = join(BACKEND_SRC, 'services', 'postEnrichment');

/**
 * Files in the enrichment directory that are not themselves enrichment steps:
 * the fan-out entry point and the shared type module.
 */
const NON_STEP_MODULES = new Set(['index.ts', 'types.ts']);

/**
 * Every route that stores a post, plus the controller directory that owns the
 * native create. These are the sources that must converge rather than enrich by
 * hand.
 */
const INGEST_ROUTES = [
  'services/PostCreationService.ts',
  'connectors/activitypub/outbox.service.ts',
  'connectors/activitypub/inbox.service.ts',
  'connectors/atproto/post.mapper.ts',
  'controllers/posts',
];

/** The enrichment step modules, derived from the directory. */
function stepModules(): string[] {
  return readdirSync(ENRICHMENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .filter((name) => !NON_STEP_MODULES.has(name))
    .sort();
}

function readSource(relativePath: string): string {
  const target = join(BACKEND_SRC, relativePath);
  // The native create is a DIRECTORY of handlers rather than a single file, and
  // every assertion below asks "does this route's source do X anywhere", so a
  // directory reads as the concatenation of its modules. Reading only one of
  // them would leave the others free to enrich by hand.
  if (!statSync(target).isDirectory()) return readFileSync(target, 'utf8');
  return readdirSync(target)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(target, name), 'utf8'))
    .join('\n');
}

/** The body of the `POST_ENRICHMENT_STEPS` array literal in the fan-out. */
function registeredStepsBlock(indexSource: string): string {
  const match = /POST_ENRICHMENT_STEPS[^=]*=\s*\[([\s\S]*?)\]/.exec(indexSource);
  if (!match) throw new Error('POST_ENRICHMENT_STEPS array literal not found in postEnrichment/index.ts');
  return match[1];
}

describe('post-ingest enrichment — every step is registered in the fan-out', () => {
  const steps = stepModules();
  const indexSource = readSource('services/postEnrichment/index.ts');
  const registered = registeredStepsBlock(indexSource);

  it('finds the enrichment steps on disk (vacuity floor)', () => {
    // If the directory were renamed or the filter broke, every assertion below
    // would pass over an empty set and this suite would silently guard nothing.
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps).toContain('linkPreviewStep.ts');
    expect(steps).toContain('mediaMetadataStep.ts');
  });

  it.each(stepModules())('registers %s in POST_ENRICHMENT_STEPS', (stepFile) => {
    const moduleName = stepFile.replace(/\.ts$/, '');
    const source = readSource(join('services', 'postEnrichment', stepFile));

    // Each step module exports exactly the function the fan-out runs; require
    // that every one of those exports is both imported and listed. A step added
    // to this directory but left out of the array would enrich nothing.
    const exported = [...source.matchAll(/export function (\w+)\(/g)].map(([, name]) => name);
    expect(exported.length).toBeGreaterThan(0);

    const stepExport = exported.find((name) => name.startsWith('enrich'));
    expect(
      stepExport,
      `${stepFile} must export an \`enrich*\` step function`,
    ).toBeDefined();

    expect(
      indexSource.includes(`from './${moduleName}'`),
      `postEnrichment/index.ts must import ./${moduleName}`,
    ).toBe(true);
    expect(
      registered.includes(String(stepExport)),
      `POST_ENRICHMENT_STEPS must list ${String(stepExport)} from ${stepFile}`,
    ).toBe(true);
  });
});

describe('post-ingest enrichment — no ingest route enriches by hand', () => {
  it('reads every ingest route (vacuity floor)', () => {
    // A typo'd path would make the per-route assertions vacuous.
    expect(INGEST_ROUTES.length).toBeGreaterThanOrEqual(5);
    for (const route of INGEST_ROUTES) {
      expect(readSource(route).length).toBeGreaterThan(0);
    }
  });

  it.each(INGEST_ROUTES)('%s does not import an enrichment step directly', (route) => {
    const source = readSource(route);

    // Importing the fan-out (`services/postEnrichment`) is the whole point and
    // is allowed. Reaching PAST it into a step module is the mistake this guard
    // exists for — it is how an enrichment ends up on one route only.
    const deepImports = [...source.matchAll(/from ['"][^'"]*postEnrichment\/([\w./]+)['"]/g)]
      .map(([full, target]) => ({ full, target }))
      .filter(({ target }) => !NON_STEP_MODULES.has(`${target}.ts`));

    expect(
      deepImports.map(({ full }) => full),
      `${route} must call enrichIngestedPosts instead of importing a step`,
    ).toEqual([]);
  });

  it('both storage routes call the converged entry point', () => {
    // The two routes that actually WRITE a post. The other ingest routes reach
    // storage through `PostCreationService`, so they inherit its call.
    const creation = readSource('services/PostCreationService.ts');
    const backfill = readSource('connectors/activitypub/outbox.service.ts');

    expect(creation).toContain('enrichIngestedPosts');
    expect(backfill).toContain('enrichIngestedPosts');

    // The native route enriches in TWO places: the immediate create, and the
    // scheduler publishing a post that was created scheduled (which `create`
    // deliberately skipped). Losing the second is how scheduled posts silently
    // went un-enriched before.
    const creationCalls = creation.match(/enrichIngestedPosts\(/g) ?? [];
    expect(creationCalls.length).toBe(2);
  });
});
