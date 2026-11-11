@AGENTS.md

## Claude Code

- Use plan mode before changes that touch the feed engine, federation, Drizzle migrations or an inter-product call.
- Path-scoped rules load automatically from `.claude/rules/` (frontend and backend gotchas).
- Do all edits in a git worktree from `origin/main`; never delegate writes to a forked subagent that shares the checkout.
