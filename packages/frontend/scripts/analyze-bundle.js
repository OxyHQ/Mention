#!/usr/bin/env bun
/* global __dirname, Buffer */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const budgetsPath = path.join(projectRoot, "bundle-budgets.json");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const enforceBudgets = args.includes("--ci");
const jsonIndex = args.indexOf("--json");
const jsonOutput = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;

if (jsonIndex >= 0 && !jsonOutput) {
  fail("--json requires an output path.");
}

if (!fs.existsSync(distDir)) {
  console.log("dist/ is missing; exporting the production web bundle first.");
  const build = spawnSync("bun", ["run", "build"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
  });
  if (build.status !== 0) {
    fail(`Frontend export failed with exit code ${String(build.status)}.`);
  }
}

if (!fs.existsSync(budgetsPath)) {
  fail(`Bundle budget file is missing: ${budgetsPath}`);
}

const budgetConfig = JSON.parse(fs.readFileSync(budgetsPath, "utf8"));
const budgets = budgetConfig.budgets || budgetConfig;
const targets = budgetConfig.targets || {};
const initialJavascriptPaths = readInitialJavascriptPaths();
const files = collectFiles(distDir)
  .filter((filePath) => !filePath.endsWith(".map"))
  .map(analyzeFile)
  .sort((a, b) => b.bytes - a.bytes);
const javascript = files.filter((file) => file.kind === "javascript");
const fonts = files.filter((file) => file.kind === "font");
const initialJavascript = javascript.filter((file) => file.initial);

const metrics = {
  totalBytes: sum(files, "bytes"),
  javascriptBytes: sum(javascript, "bytes"),
  javascriptGzipBytes: sum(javascript, "gzipBytes"),
  javascriptBrotliBytes: sum(javascript, "brotliBytes"),
  initialJavascriptBytes: sum(initialJavascript, "bytes"),
  initialJavascriptGzipBytes: sum(initialJavascript, "gzipBytes"),
  initialJavascriptBrotliBytes: sum(initialJavascript, "brotliBytes"),
  fontBytes: sum(fonts, "bytes"),
  largestFileBytes: files[0]?.bytes || 0,
};

const violations = Object.entries(budgets)
  .filter(([metric, limit]) => {
    if (typeof limit !== "number" || !(metric in metrics)) {
      fail(`Unknown or invalid bundle budget: ${metric}=${String(limit)}`);
    }
    return metrics[metric] > limit;
  })
  .map(([metric, limit]) => ({
    metric,
    actual: metrics[metric],
    limit,
    overBy: metrics[metric] - limit,
  }));

const targetStatus = Object.entries(targets).map(([metric, target]) => {
  if (typeof target !== "number" || !(metric in metrics)) {
    fail(`Unknown or invalid bundle target: ${metric}=${String(target)}`);
  }
  return {
    metric,
    actual: metrics[metric],
    target,
    gap: metrics[metric] - target,
    met: metrics[metric] <= target,
  };
});

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  metrics,
  budgets,
  targets,
  targetStatus,
  violations,
  counts: {
    files: files.length,
    javascript: javascript.length,
    initialJavascript: initialJavascript.length,
    fonts: fonts.length,
  },
  initialJavascript: initialJavascript.map(({ path: filePath, bytes, gzipBytes, brotliBytes }) => ({
    path: filePath,
    bytes,
    gzipBytes,
    brotliBytes,
  })),
  routes: buildRouteReport(javascript.filter((file) => !file.initial)),
  initialSources: buildSourceReport(initialJavascript),
  sources: buildSourceReport(javascript),
  iconFamilies: fonts.map(({ path: filePath, bytes }) => ({
    family: iconFamilyName(filePath),
    path: filePath,
    bytes,
  })).sort((a, b) => b.bytes - a.bytes),
  largestFiles: files.slice(0, 15),
};

printReport(report);

if (jsonOutput) {
  const outputPath = path.resolve(process.cwd(), jsonOutput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bundle report written to ${outputPath}`);
}

if (enforceBudgets && violations.length > 0) {
  process.exit(1);
}

function collectFiles(directory) {
  const collected = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function analyzeFile(filePath) {
  const relativePath = path.relative(distDir, filePath).split(path.sep).join("/");
  const extension = path.extname(relativePath).toLowerCase();
  const kind = classify(extension);
  const contents = fs.readFileSync(filePath);
  const compressible = kind === "javascript" || kind === "stylesheet" || kind === "html";

  return {
    path: relativePath,
    kind,
    initial:
      kind === "javascript" &&
      initialJavascriptPaths.has(relativePath),
    bytes: contents.byteLength,
    gzipBytes: compressible ? zlib.gzipSync(contents, { level: 9 }).byteLength : null,
    brotliBytes: compressible
      ? zlib.brotliCompressSync(contents, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        }).byteLength
      : null,
  };
}

function readInitialJavascriptPaths() {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) return new Set();

  const html = fs.readFileSync(indexPath, "utf8");
  const paths = new Set();
  const sourcePattern = /<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi;
  for (const match of html.matchAll(sourcePattern)) {
    const pathname = new URL(match[1], "https://mention.invalid").pathname;
    paths.add(pathname.replace(/^\/+/, ""));
  }
  return paths;
}

function readSourceMap(file) {
  const mapPath = path.join(distDir, `${file.path}.map`);
  if (!fs.existsSync(mapPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf8"));
  } catch (error) {
    console.warn(`Skipping unreadable source map ${mapPath}: ${error.message}`);
    return null;
  }
}

function buildRouteReport(routeFiles) {
  const grouped = new Map();
  for (const file of routeFiles) {
    const sourceMap = readSourceMap(file);
    const appSources = (sourceMap?.sources || [])
      .filter((source) => source.includes("/packages/frontend/app/"))
      .map(routeNameFromSource);
    const routeNames = [...new Set(appSources)];
    const names = routeNames.length > 0
      ? routeNames
      : [`async:${path.basename(file.path).replace(/-[a-f0-9]{32}\.js$/, "")}`];

    for (const route of names) {
      const current = grouped.get(route) || {
        route,
        bytes: 0,
        gzipBytes: 0,
        brotliBytes: 0,
        chunks: [],
      };
      current.bytes += file.bytes;
      current.gzipBytes += file.gzipBytes || 0;
      current.brotliBytes += file.brotliBytes || 0;
      current.chunks.push(file.path);
      grouped.set(route, current);
    }
  }
  return [...grouped.values()].sort((a, b) => b.gzipBytes - a.gzipBytes);
}

function routeNameFromSource(source) {
  const marker = "/packages/frontend/app/";
  const relative = source.slice(source.indexOf(marker) + marker.length)
    .replace(/\.(tsx?|jsx?)$/, "")
    .replace(/\/index$/, "")
    .replace(/\/_layout$/, "");
  return `/${relative.replace(/\([^/]+\)\//g, "")}`.replace(/\/+/g, "/");
}

function buildSourceReport(javascriptFiles) {
  const grouped = new Map();
  for (const file of javascriptFiles) {
    const sourceMap = readSourceMap(file);
    if (!sourceMap?.sources?.length || !sourceMap.sourcesContent?.length) continue;

    for (let index = 0; index < sourceMap.sources.length; index += 1) {
      const contents = sourceMap.sourcesContent[index];
      if (typeof contents !== "string" || contents.length === 0) continue;
      const group = sourceGroup(sourceMap.sources[index]);
      const buffer = Buffer.from(contents);
      const current = grouped.get(group) || {
        source: group,
        files: 0,
        sourceBytes: 0,
        isolatedGzipBytes: 0,
        isolatedBrotliBytes: 0,
      };
      current.files += 1;
      current.sourceBytes += buffer.byteLength;
      current.isolatedGzipBytes += zlib.gzipSync(buffer, { level: 9 }).byteLength;
      current.isolatedBrotliBytes += zlib.brotliCompressSync(buffer, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }).byteLength;
      grouped.set(group, current);
    }
  }
  return [...grouped.values()].sort((a, b) => b.isolatedGzipBytes - a.isolatedGzipBytes);
}

function sourceGroup(source) {
  const dependency = source.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (dependency) return dependency[1];
  if (source.includes("/packages/frontend/")) return "@mention/frontend";
  if (source.includes("/packages/shared-types/")) return "@mention/shared-types";
  return "other";
}

function iconFamilyName(filePath) {
  const filename = path.basename(filePath);
  return filename.replace(/\.[a-f0-9]{32}(?=\.)/, "").replace(/\.(ttf|otf|woff2?)$/, "");
}

function classify(extension) {
  if (extension === ".js" || extension === ".mjs") return "javascript";
  if (extension === ".css") return "stylesheet";
  if (extension === ".html") return "html";
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(extension)) return "font";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif"].includes(extension)) {
    return "image";
  }
  if (extension === ".wasm") return "wasm";
  return extension ? extension.slice(1) : "other";
}

function sum(items, property) {
  return items.reduce((total, item) => total + (item[property] || 0), 0);
}

function printReport(report) {
  console.log("Mention frontend bundle report\n");
  for (const [metric, value] of Object.entries(report.metrics)) {
    const limit = report.budgets[metric];
    const suffix = typeof limit === "number" ? ` / budget ${formatBytes(limit)}` : "";
    console.log(`${metric}: ${formatBytes(value)}${suffix}`);
  }

  if (report.targetStatus.length > 0) {
    console.log("\nLong-term targets:");
    for (const target of report.targetStatus) {
      const state = target.met ? "met" : `${formatBytes(target.gap)} remaining`;
      console.log(`- ${target.metric}: ${formatBytes(target.actual)} / target ${formatBytes(target.target)} (${state})`);
    }
  }

  console.log("\nInitial JavaScript chunks:");
  for (const file of report.initialJavascript) {
    console.log(
      `- ${file.path}: ${formatBytes(file.bytes)} raw, ${formatBytes(file.gzipBytes)} gzip`,
    );
  }

  console.log("\nLargest files:");
  for (const file of report.largestFiles.slice(0, 10)) {
    console.log(`- ${file.path}: ${formatBytes(file.bytes)} (${file.kind})`);
  }

  if (report.routes.length > 0) {
    console.log("\nLargest route/async chunks:");
    for (const route of report.routes.slice(0, 10)) {
      console.log(`- ${route.route}: ${formatBytes(route.gzipBytes)} gzip`);
    }
  }

  if (report.initialSources.length > 0) {
    console.log("\nLargest initial source groups (isolated gzip attribution):");
    for (const source of report.initialSources.slice(0, 10)) {
      console.log(`- ${source.source}: ${formatBytes(source.isolatedGzipBytes)}`);
    }
  }

  if (report.sources.length > 0) {
    console.log("\nLargest source groups (isolated gzip attribution):");
    for (const source of report.sources.slice(0, 10)) {
      console.log(`- ${source.source}: ${formatBytes(source.isolatedGzipBytes)}`);
    }
  }

  if (report.iconFamilies.length > 0) {
    console.log("\nIcon/font families:");
    for (const icon of report.iconFamilies) {
      console.log(`- ${icon.family}: ${formatBytes(icon.bytes)}`);
    }
  }

  if (report.violations.length === 0) {
    console.log("\nAll configured bundle budgets pass.");
  } else {
    console.error("\nBundle budget violations:");
    for (const violation of report.violations) {
      console.error(
        `- ${violation.metric}: ${formatBytes(violation.actual)} exceeds ${formatBytes(violation.limit)} by ${formatBytes(violation.overBy)}`,
      );
    }
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(2)} ${unit}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
