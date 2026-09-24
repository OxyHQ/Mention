#!/usr/bin/env bun

/**
 * Keeps whole-store subscriptions out of the feed-row hot path (issue #1103).
 *
 * ## Why a guard
 *
 * A feed row is mounted dozens of times and recycled on every fling. The posts
 * store is deliberately keyed (`usePostSelector(postId)`, `useViewCountSelector`)
 * so a write to post A wakes only A's row. One bare `usePostsStore()` in a hook
 * every row mounts undoes all of that: a zustand hook called WITHOUT a selector
 * subscribes to the whole store snapshot, so every `feedUI` / `isLoading` /
 * `error` write anywhere in the app re-renders every mounted row. That shipped
 * in four engagement hooks at once and nothing failed — it is invisible in a
 * diff and only shows up as a slow fling. So it is a rule, not a review memory.
 *
 * ## What it checks
 *
 * In the hot-path files below, any `use<Name>Store()` call with an empty
 * argument list. Select the fields you need instead:
 *
 *     const likePost = usePostsStore((s) => s.likePost);
 *
 * Comments are stripped before matching, so prose explaining the rule (like the
 * line above) never trips it. Tests are exempt: a test may read the whole store.
 *
 * ## Second rule: an embedded Feed is bounded
 *
 * A `<Feed scrollEnabled={false}>` renders inside a parent scroller and is NOT
 * virtualized — every row it holds stays mounted — so an unbounded one inside an
 * unbounded parent grows with every page. Anywhere under app/ or components/,
 * a Feed whose `scrollEnabled` can be `false` must either pass `previewLimit`
 * or carry a `bounded-feed:` comment just above it saying why it is bounded.
 *
 * Usage:  bun scripts/validate-feed-hot-path.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.FEED_HOT_PATH_VALIDATOR_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Code mounted once per feed row, per media cell, or per reel page. Paths are
 * relative to packages/frontend.
 */
const HOT_PATH = [
  /^components\/Feed\//,
  /^components\/Post\//,
  /^components\/CommunityNotes\//,
  /^components\/common\/(VideoPlayer|LinkifiedText)\.tsx$/,
  /^components\/ui\/LiveAvatar\.tsx$/,
  /^hooks\/usePost[A-Za-z]*\.tsx?$/,
  /^hooks\/useLiveUsers?\.tsx?$/,
  /^app\/\(app\)\/\(tabs\)\/videos\.tsx$/,
];

const SOURCE = /\.(ts|tsx)$/;
const EXEMPT = /(^|\/)__tests__\/|\.test\.tsx?$/;

/** A floor so a broken file listing cannot report a clean tree. */
const MIN_FILES = process.env.FEED_HOT_PATH_VALIDATOR_FIXTURE_FLOORS ? 1 : 40;

const BARE_STORE_CALL = /\buse[A-Z][A-Za-z0-9]*Store\(\s*\)/g;

/** Where an embedded Feed can be written. */
const FEED_CALLERS = [/^app\//, /^components\//];
const FEED_ELEMENT = /<Feed\b([\s\S]*?)\/>/g;
const SCROLL_DISABLED = /scrollEnabled=\{[^}]*\bfalse\b[^}]*\}/;
const BOUNDED_MARKER = /bounded-feed:/;

/** Blanks comments out character for character, so offsets and lines still match the source. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])(\/\/[^\n]*)/g, (_m, lead, comment) => lead + " ".repeat(comment.length));
}

const listing = spawnSync("git", ["ls-files", "packages/frontend"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (listing.status !== 0) {
  console.error(`validate-feed-hot-path: git ls-files failed:\n${listing.stderr}`);
  process.exit(1);
}

const files = listing.stdout
  .split("\n")
  .filter(Boolean)
  .map((p) => p.replace(/^packages\/frontend\//, ""))
  .filter((p) => SOURCE.test(p) && !EXEMPT.test(p) && HOT_PATH.some((r) => r.test(p)));

if (files.length < MIN_FILES) {
  console.error(
    `validate-feed-hot-path: only ${files.length} hot-path files found (floor ${MIN_FILES}); the listing is broken or the hot-path patterns no longer match the tree.`,
  );
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const text = stripComments(await readFile(resolve(ROOT, "packages/frontend", file), "utf8"));
  for (const match of text.matchAll(BARE_STORE_CALL)) {
    const line = text.slice(0, match.index).split("\n").length;
    violations.push(`packages/frontend/${file}:${line}  ${match[0]}`);
  }
}

const allSources = listing.stdout
  .split("\n")
  .filter(Boolean)
  .map((p) => p.replace(/^packages\/frontend\//, ""))
  .filter((p) => SOURCE.test(p) && !EXEMPT.test(p) && FEED_CALLERS.some((r) => r.test(p)));

const unbounded = [];
for (const file of allSources) {
  const raw = await readFile(resolve(ROOT, "packages/frontend", file), "utf8");
  if (!raw.includes("<Feed")) continue;
  // Elements are found in the comment-free text (prose may mention `<Feed>`);
  // the justification is read from the raw text at the same offset.
  const code = stripComments(raw);
  for (const match of code.matchAll(FEED_ELEMENT)) {
    const props = match[1];
    if (!SCROLL_DISABLED.test(props) || /\bpreviewLimit=/.test(props)) continue;
    const before = raw.slice(0, match.index).split("\n").slice(-8).join("\n");
    if (BOUNDED_MARKER.test(before)) continue;
    const line = raw.slice(0, match.index).split("\n").length;
    unbounded.push(`packages/frontend/${file}:${line}`);
  }
}

if (unbounded.length > 0) {
  console.error(
    "validate-feed-hot-path: unbounded embedded Feed.\n" +
      "A Feed with scrollEnabled={false} is not virtualized: every row stays mounted and it grows with each page.\n" +
      "Pass `previewLimit`, let the Feed own the scroll, or add a `bounded-feed:` comment above it saying why it is bounded.\n\n" +
      unbounded.join("\n"),
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    "validate-feed-hot-path: whole-store subscription in feed-row hot-path code.\n" +
      "A zustand hook called without a selector re-renders every mounted row on any store write.\n" +
      "Select the fields you need, e.g. `usePostsStore((s) => s.likePost)`.\n\n" +
      violations.join("\n"),
  );
  process.exit(1);
}

console.log(
  `validate-feed-hot-path: ${files.length} hot-path files, no whole-store subscriptions; every embedded Feed is bounded.`,
);
