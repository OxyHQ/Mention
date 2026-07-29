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
    if (isQuery(cond)) {
      // The two field-level operator forms these handlers build: the object
      // spelling of a regex match, and an equality negation.
      if (typeof cond.$regex === 'string') {
        const flags = typeof cond.$options === 'string' ? cond.$options : '';
        return typeof value === 'string' && new RegExp(cond.$regex, flags).test(value);
      }
      if ('$ne' in cond) {
        return Array.isArray(value) ? !value.includes(cond.$ne) : value !== cond.$ne;
      }
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

/**
 * A chainable query builder over an already-filtered set of documents.
 *
 * `onSort` receives the sort spec the handler built. Offset pagination is only
 * safe on a TOTAL order — a sort that can tie leaves the tied rows free to swap
 * places between two page requests, dropping or duplicating rows at the page
 * boundary. That drift needs concurrent writes or a query-plan change to appear,
 * so no amount of single-node paging can assert it: the sort SPEC is the only
 * thing a test can check that actually fails when someone removes the tie-break.
 */
export function makeQuery(docs: Doc[], onSort?: (spec: SortSpec) => void) {
  let sortSpec: SortSpec = {};
  let skipN = 0;
  let limitN: number | undefined;
  const builder = {
    sort(spec: SortSpec) {
      sortSpec = spec;
      onSort?.(spec);
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
