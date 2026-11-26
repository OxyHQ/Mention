#!/usr/bin/env node
/**
 * DEV ONLY: what each form of the screen costs to compile (README.md here).
 *
 *   cd packages/frontend && node __perf__/lang-proof/compile-time.cjs
 *
 * Per file, as Metro transforms it: the Bloom step (bloomc for the `.bloom`
 * port, the embedded-language pass for the TypeScript forms), then Babel with
 * Expo's preset and the React Compiler (a production web caller). Medians of
 * RUNS after WARMUP, interleaved; bloomc alone also over 200 calls. Writes
 * `results/compile.json`.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const fromApp = (id) => require(require.resolve(id, { paths: [root] }));
const babel = fromApp('@babel/core');
const { compileBloomModule, compileModule } = require(
  path.join(
    path.dirname(require.resolve('@oxy.so/bloom-language-compiler/metro', { paths: [root] })),
    'compile.js',
  ),
);
const preset = require.resolve('babel-preset-expo', { paths: [root] });

const FILES = {
  original: '__perf__/lang-proof/variants/original.tsx',
  cleaned: '__perf__/lang-proof/variants/cleaned.tsx',
  bloom: 'components/settings/pages/notifications.bloom',
};
const RUNS = 40;
const WARMUP = 5;
const caller = {
  name: 'metro',
  bundler: 'metro',
  platform: 'web',
  isDev: false,
  isServer: false,
  supportsReactCompiler: true,
};
const ms = (from, to) => Number(to - from) / 1e6;

function transform(name) {
  const filename = path.join(root, FILES[name]);
  const source = fs.readFileSync(filename, 'utf8');
  const start = process.hrtime.bigint();
  const bloom =
    name === 'bloom'
      ? { code: compileBloomModule(source, filename, { root }).code, host: `${filename}.ts` }
      : { code: compileModule(source, filename)?.code ?? source, host: filename };
  const compiled = process.hrtime.bigint();
  babel.transformSync(bloom.code, {
    filename: bloom.host,
    cwd: root,
    babelrc: false,
    configFile: false,
    presets: [preset],
    caller,
  });
  return [ms(start, compiled), ms(compiled, process.hrtime.bigint())];
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
};

const samples = Object.fromEntries(
  Object.keys(FILES).map((name) => [name, { bloom: [], babel: [] }]),
);
for (let run = 0; run < WARMUP + RUNS; run += 1) {
  for (const name of Object.keys(FILES)) {
    const [bloomStep, babelStep] = transform(name);
    if (run >= WARMUP) {
      samples[name].bloom.push(bloomStep);
      samples[name].babel.push(babelStep);
    }
  }
}

const bloomFile = path.join(root, FILES.bloom);
const bloomSource = fs.readFileSync(bloomFile, 'utf8');
const alone = [];
for (let i = 0; i < 200; i += 1) {
  const start = process.hrtime.bigint();
  compileBloomModule(bloomSource, bloomFile, { root });
  alone.push(ms(start, process.hrtime.bigint()));
}

const results = {
  meta: { runs: RUNS, warmup: WARMUP, node: process.version, caller },
  bloomcAlone: {
    median: median(alone),
    p95: Math.round([...alone].sort((a, b) => a - b)[190] * 100) / 100,
  },
  perFile: Object.fromEntries(
    Object.entries(samples).map(([name, s]) => [
      name,
      {
        bloomStep: median(s.bloom),
        babelWithReactCompiler: median(s.babel),
        total: median(s.bloom.map((value, i) => value + s.babel[i])),
      },
    ]),
  ),
};
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, 'results', 'compile.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
