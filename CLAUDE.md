@AGENTS.md

## Claude Code

- Use plan mode before changes that touch the feed engine, federation, Drizzle migrations or an inter-product call.
- Frontend and backend gotchas live in [frontend-rules](./docs/frontend-rules.md) and the package `AGENTS.md` files; the mechanical ones are enforced by `bun run validate:source-rules`.
- Do all edits in a git worktree from `origin/main`; never delegate writes to a forked subagent that shares the checkout.
