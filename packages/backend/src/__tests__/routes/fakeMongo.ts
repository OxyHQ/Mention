/**
 * A tiny in-memory stand-in for the sliver of Mongoose the search list routes
 * use — `Model.find(q).sort().skip().limit().lean()` and `countDocuments(q)`.
 *
 * It is NOT a general query engine: it implements only the operators these
 * handlers actually build (`$or`, `$and`, field equality, and a `RegExp` value
 * on a string field), which is exactly enough to exercise the real
 * visibility-gate + search-filter + offset-pagination behaviour against seeded
 * documents. Pure (no vitest import) so a `vi.mock` factory can wire it through
 * `mockImplementation` at test time.
 */

export type Doc = Record<string, unknown>;
export type Query = Record<string, unknown>;

function isQuery(value: unknown): value is Query {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a document satisfies a Mongo-style query condition. */
export function matchCondition(doc: Doc, query: Query): boolean {
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') {
      return Array.isArray(cond) && cond.some((sub) => isQuery(sub) && matchCondition(doc, sub));
    }
    if (key === '$and') {
      return Array.isArray(cond) && cond.every((sub) => isQuery(sub) && matchCondition(doc, sub));
    }
    const value = doc[key];
    if (cond instanceof RegExp) {
      return typeof value === 'string' && cond.test(value);
    }
    return value === cond;
  });
}

type SortSpec = Record<string, 1 | -1>;

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}

/** A chainable query builder over an already-filtered set of documents. */
export function makeQuery(docs: Doc[]) {
  let sortSpec: SortSpec = {};
  let skipN = 0;
  let limitN: number | undefined;
  const builder = {
    sort(spec: SortSpec) {
      sortSpec = spec;
      return builder;
    },
    skip(n: number) {
      skipN = n;
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    lean() {
      const sorted = [...docs].sort((a, b) => {
        for (const [key, dir] of Object.entries(sortSpec)) {
          const c = compareValues(a[key], b[key]);
          if (c !== 0) return c * dir;
        }
        return 0;
      });
      const end = limitN === undefined ? undefined : skipN + limitN;
      return Promise.resolve(sorted.slice(skipN, end));
    },
  };
  return builder;
}
