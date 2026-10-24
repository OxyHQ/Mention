# React Compiler and web virtualization — measured findings

Deep detail behind the frontend rules in `AGENTS.md`.

## A render-phase ref write is REFUSED, not miscompiled

Writing a ref during render (`const r = useRef(x); r.current = x;` at the
top level of a component or hook) does NOT produce a stale read with the
compiler this app ships. Measured against the installed
`babel-plugin-react-compiler` with the options `babel-preset-expo` passes in
production (`target: '19'`, `panicThreshold: 'NONE'`): the compiler emits

```
CompileError: Ref values (the `current` property) may not be accessed during render.
```

and bails on the entire function, which then ships completely unoptimized.
Control, same code with a closure instead of the ref: compiles to `_c(3)`.

So the live cost of this pattern today is lost memoization for the whole
component or hook, not a stale value — one such line silently opts a file
out of the compiler. Staleness remains a real risk, but through discarded
concurrent renders, not through the compiler.

This matters because the fix is the same either way (close over the value
and add it to the dep array, after checking callers pass a stable identity)
but the REASON in a commit message or a review comment is often stated
wrongly — including in `2ee96d48` and `29b82e5f`, which are correct fixes
with an inaccurate rationale.

To check a specific site rather than reason about it, compile it with the
app's own plugin and look for `_c(n)` versus a `CompileError` in the
logger — a dozen lines settles the question in seconds.

Distinct from the ecosystem rule in `~/AGENTS.md` about reading external
mutable state inside a memoized position, which IS a stale-read hazard.
Reading a ref in render and writing one in render fail differently.

A `finally` CLAUSE also bails the whole function (BuildHIR cannot lower
it), while the promise `.finally()` METHOD is fine. Measured on the same
plugin, one synthetic hook per shape against a no-try control at `_c(6)`:

| shape | result |
|---|---|
| no `try` at all (control) | `_c(6)` |
| `try` / `catch` | `_c(5)` |
| `try` / `finally` | **bails** |
| `try` / `catch` / `finally` | **bails** |
| `try` / `catch`, cleanup duplicated into both paths | `_c(6)` |
| promise `.finally()` method | `_c(6)` |
| `try` / `finally` nested inside a `try` / `catch` | **bails** |

But a bail is NOT by itself evidence of a missing optimization. Three hooks
were audited for this (`useProfileScroll`, `useDrafts`, `useDeferredToggle`)
and none was worth unlocking: they are already densely hand-memoized, and
the compiler's inferred deps came out as the SAME sets as the hand-written
arrays — so the cache it would add holds values nothing observes
(`useDeferredToggle`'s entire net win was caching a returned object that
both consumers destructure on the spot). Two of the three could not be
unlocked at any acceptable price: `useProfileScroll` has no
compiler-acceptable form for a throttle timestamp (ref → flagged, closure
`let` → "reassigning a variable after render has completed", `useState` →
a re-render per scroll check), and `useDrafts` would require rewriting
four hand-written dep arrays to match inference, changing when
viewer-isolation callbacks change identity.

The compiler pays off where code is NOT already hand-memoized. Check what
the optimization would CONTAIN before spending a refactor to unlock it, and
never restructure a `try`/`finally` that exists to guarantee cleanup on the
error path — that trades correctness for a cache.

## Web list virtualization lives in Bloom

Every virtualized web list here (`Feed.web.tsx`, `NotificationsList.web.tsx`,
`SavedPostsList.web.tsx`, `ProfileGridList.web.tsx`) renders Bloom's
`VirtualList` (`@oxy.so/bloom/list`). It windows against the scroller of the
Screen in front — the window for document flow, the panel element for an
element-kind panel — re-reads its origin when a retained screen is shown again,
paginates through `onEndReached`, and stays idle while its Screen is inactive.
None of that is Mention's code any more, and neither are its tests.

The compiler finding that drove the old app-local virtualizers still holds for
anything that calls `@tanstack/react-virtual` directly: the virtualizer instance
is stable for the component's lifetime and re-renders through a reducer internal
to the hook, so a compiled caller serves its first `getTotalSize()` /
`getVirtualItems()` forever in production builds (dev hides it — fast refresh
clears the cache on every edit). `ProfileGridList` once shipped that way: 8 rows
and ~550px of blank below them. Do not add a second virtualizer to the app;
extend Bloom's. If one is unavoidable, opt it out with `'use no memo'`, compile
it with the app's own `babel-plugin-react-compiler` and read the
CompileError/CompileSuccess events, and verify on a PROD build (`expo export
web`), not the dev server.

A row that needs its own DOM observation (the web feed's impression tracking)
wraps its content in a node of its own inside `renderItem` and observes that,
never the list's measured row element.
