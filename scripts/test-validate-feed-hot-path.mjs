#!/usr/bin/env bun

/**
 * Mutation-tests `validate-feed-hot-path.mjs` against real scratch git trees, so
 * the guard's actual file listing runs. Each failing case must fail with the
 * words that name the rule; each passing case pins a near-miss that must stay
 * legal (selectors, comments, tests, files outside the hot path).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-feed-hot-path.mjs");

async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "feed-hot-path-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, "packages/frontend", path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });
    const env = { ...process.env, FEED_HOT_PATH_VALIDATOR_ROOT: root };
    if (!realFloors) env.FEED_HOT_PATH_VALIDATOR_FIXTURE_FLOORS = "1";
    const result = Bun.spawnSync({ cmd: ["bun", validator], env });
    return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const clean = "export const ok = () => usePostsStore((s) => s.likePost);\n";

const cases = [
  { name: "selector passes", files: { "hooks/usePostLike.ts": clean }, pass: true },
  {
    name: "bare usePostsStore in a row hook fails",
    files: { "hooks/usePostLike.ts": "const { likePost } = usePostsStore();\n" },
    pass: false,
    expect: "hooks/usePostLike.ts:1",
  },
  {
    name: "bare store with whitespace in a Feed component fails",
    files: { "components/Feed/Row.tsx": "const s = useVideoMuteStore( );\n" },
    pass: false,
    expect: "components/Feed/Row.tsx:1",
  },
  {
    name: "reel screen is hot path",
    files: { "app/(app)/(tabs)/videos.tsx": "\n\nconst x = usePostsStore();\n" },
    pass: false,
    expect: "videos.tsx:3",
  },
  {
    name: "comments explaining the rule pass",
    files: {
      "hooks/usePostSave.ts": `// a bare usePostsStore() subscribes to everything\n/* usePostsStore() */\n${clean}`,
    },
    pass: true,
  },
  {
    name: "tests are exempt",
    files: {
      "hooks/usePostLike.ts": clean,
      "hooks/__tests__/usePostLike.test.ts": "usePostsStore();\n",
    },
    pass: true,
  },
  {
    name: "screens outside the hot path are not checked",
    files: { "hooks/usePostLike.ts": clean, "components/Compose/ComposeScreen.tsx": "usePostsStore();\n" },
    pass: true,
  },
  {
    name: "vacuity floor fires on a tiny tree",
    files: { "hooks/usePostLike.ts": clean },
    realFloors: true,
    pass: false,
    expect: "floor",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { code, output } = await runAgainst(testCase.files, { realFloors: testCase.realFloors });
  const ok = testCase.pass
    ? code === 0
    : code !== 0 && (!testCase.expect || output.includes(testCase.expect));
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${testCase.name} (exit ${code})\n${output}`);
  }
}

if (failed > 0) {
  console.error(`test-validate-feed-hot-path: ${failed}/${cases.length} cases failed`);
  process.exit(1);
}
console.log(`test-validate-feed-hot-path: ${cases.length} cases passed`);
