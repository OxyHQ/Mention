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

## Web feed virtualization — why `Math.max(totalSize, lastItemEnd)` stays

`packages/frontend/components/Feed/Feed.web.tsx`'s spacer size uses
`Math.max(totalSize, lastItemEnd)` (`virtualItems.at(-1)?.end ?? 0`). Keep
it — but it is belt-and-braces, and the story it used to carry ("on prod
builds `getTotalSize()` can return 0 even with measured rows") was NOT a
react-virtual quirk. It was the React Compiler, and the mechanism
generalizes to every virtualized web list here.

`useWindowVirtualizer` returns an instance whose identity is stable for the
component's lifetime (`useState(() => new Virtualizer(...))`) and forces
re-renders through a reducer INTERNAL to the hook. Nothing the component
can see changes on scroll, so the compiler caches `getTotalSize()` — and,
when its grouping reaches that far, `getVirtualItems()` and the whole row
JSX — keyed on props plus that stable instance, and serves the first result
forever. Dev hides it (`enableResetCacheOnSourceFileChanges` is true there,
so fast refresh clears the cache on every edit); prod does not.

Verified by compiling `Feed.web.tsx` as of `e4ea113f`, the commit that
added the `Math.max`: it compiled, with `getTotalSize()` frozen on
`virtualizer`. `ce87804e` an hour later added a render-phase ref write that
made the compiler refuse the whole function, removing the freeze BY
ACCIDENT — which is why `Math.max` has been redundant since. Do not remove
it; a workaround whose cause is gone is still cheap insurance.

A virtualized web list must therefore be opted out explicitly.
`ProfileGridList.web.tsx` and `SavedPostsList.web.tsx` carry
`'use no memo'` with the reason in-source; `Feed.web.tsx` and
`NotificationsList.web.tsx` are opted out only ACCIDENTALLY, by reading a
ref during render — `Feed.web.tsx` carries a comment saying so, because
removing those reads reintroduces the freeze in the most-used screen in the
app. Symptoms differ by how far the grouping reached: a frozen
`getTotalSize()` alone means a short spacer and sticky rails that scroll
away; a frozen `getVirtualItems()` means rows past the first window never
mount (`ProfileGridList` shipped that way — 8 rows and ~550px of blank
below them).

Do NOT reason about which shape is safe: grouping is per-file, and a
captured ref does NOT reliably prevent it (measured both ways). Compile the
file with the app's own `babel-plugin-react-compiler` and read the
CompileError/CompileSuccess events — not a grep of the output, which
comments like these will match. Always verify virtualization bugs on a PROD
build (`expo export web`), not the dev server.
