# Frontend (Expo)

Expo / React Native app for iOS, Android and web. Root rules in `../../AGENTS.md` apply.

## Commands

Run from `packages/frontend`.

```bash
bun run dev              # Expo dev server (Metro on 8110, tunnel)
bun run typecheck        # tsc --noEmit
bun run lint             # expo lint . (Biome covers the rest from the root)
bun run test             # Jest, --runInBand
bun run test:coverage    # what CI runs; policy in coverage-policy.json
bun run build            # web export with tree shaking
```

## Conventions

- Frontend rules and gotchas: [docs/frontend-rules.md](../../docs/frontend-rules.md); React Compiler findings: [docs/frontend-compiler-notes.md](../../docs/frontend-compiler-notes.md).
- Coverage ratchet: run `coverage:record` only when `coverage:check` asks, and commit `coverage-baseline.json` with it ([TESTING-POLICY](./docs/TESTING-POLICY.md)).
- Keep `import('hls.js')` a single call site; a second dynamic import moves the demuxer into the eager chunk.
- Gate HLS support on `MediaSource.isTypeSupported`, never `canPlayType`.
