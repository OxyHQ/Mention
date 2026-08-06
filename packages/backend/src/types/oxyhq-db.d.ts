/**
 * Type-only bridge for `@oxyhq/db`'s subpath exports.
 *
 * This package's `moduleResolution` is `"node"` (classic) — the ECS image runs
 * `bun`/compiled CommonJS, and that setting is load-bearing for the other ~500
 * files in this package (see `tsconfig.json`). Classic resolution does not
 * consult `package.json` `exports` at all, so `@oxyhq/db`'s bare import
 * resolves fine (it has a legacy top-level `types` field), but its SUBPATH
 * exports (`./migrate`, `./expiry`, `./testing`) are reachable only through
 * `exports` and are otherwise invisible to `tsc`.
 *
 * A `tsconfig.json` `paths` remap was tried first and reverted: Bun's runtime
 * ALSO honours `paths` (unlike plain Node), so mapping a subpath straight to
 * its `.d.ts` file broke `bun src/db/migrate.ts` at runtime — Bun resolved the
 * import against the types-only file instead of the real ESM/CJS build.
 * Ambient module declarations have no such risk: they are erased entirely at
 * compile time, so the REAL `import … from '@oxyhq/db/migrate'` statements in
 * `.ts` files still resolve at runtime through Node's/Bun's own
 * `exports`-aware resolver, unaffected by anything in this file. Only `tsc`'s
 * type-check reads this.
 */

declare module '@oxyhq/db/migrate' {
  export * from '@oxyhq/db/dist/types/migrate/index';
}

declare module '@oxyhq/db/expiry' {
  export * from '@oxyhq/db/dist/types/expiry';
}

declare module '@oxyhq/db/testing' {
  export * from '@oxyhq/db/dist/types/testing';
}
