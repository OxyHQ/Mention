// Live development against LOCAL library checkouts, for `expo start` only
// (docs/development.md, "Developing against a local Bloom checkout").
//
//   OXY_LOCAL_BLOOM_SOURCE=<Bloom checkout>         @oxy.so/bloom and its packages/*
//   OXY_LOCAL_PEABLE_SDK_SOURCE=<Peable packages/sdk> @peable.to/sdk/checkout(/ui)
//
// Either variable alone turns this on; with neither set `metro.config.js` never
// loads this file, so installs, exports, Jest and CI keep the published packages.
//
// Each request for a local package resolves to the file its `react-native` export
// names (Bloom's `src/`), with the script extension dropped so Metro picks the
// platform fork (`index.web.ts` on web, `.native.tsx` on Android/iOS). The
// checkouts are watched, so an edit there Fast Refreshes like app code. A bare
// import made FROM a checkout resolves from the app, never from the checkout's own
// node_modules (blocked below): one React, React Native, Reanimated, NativeWind
// and react-native-css, whatever the checkout has installed.
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_EXTENSION = /\.(?:tsx?|jsx?)$/;
// Never crawled or resolved in a checkout or its `packages/<name>`: their own
// installs, build output, native projects, tests and nested worktrees.
const BLOCKED_DIRS = [
  'node_modules',
  '.git',
  '.local',
  '.worktrees',
  'lib',
  'dist',
  'android',
  'ios',
  '__tests__',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkoutRoot(variable, value) {
  if (!value) return null;
  const root = path.resolve(value);
  if (!fs.existsSync(root)) throw new Error(`${variable}=${value} does not exist`);
  // Metro reports real paths; a symlinked checkout must compare the same way.
  return fs.realpathSync(root);
}

/** The local file of `subpath` ('.', './button', …) in a package's export map, or null. */
function exportTarget(root, exportsMap, subpath) {
  let entry = exportsMap[subpath];
  let star;
  if (entry === undefined) {
    const pattern = Object.keys(exportsMap).find((key) => {
      const [prefix, suffix, extra] = key.split('*');
      return (
        suffix !== undefined &&
        extra === undefined &&
        subpath.length >= prefix.length + suffix.length &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix)
      );
    });
    if (!pattern) return null;
    const [prefix, suffix] = pattern.split('*');
    star = subpath.slice(prefix.length, subpath.length - suffix.length);
    entry = exportsMap[pattern];
  }
  const condition = typeof entry === 'string' ? entry : entry?.['react-native'];
  let target = typeof condition === 'string' ? condition : condition?.default;
  if (typeof target !== 'string') return null;
  if (star !== undefined) target = target.replaceAll('*', star);
  return path.resolve(root, target).replace(SCRIPT_EXTENSION, '');
}

/** A package whose export map is re-read when its package.json changes (a regenerated map). */
function localPackage(root) {
  const manifestPath = path.join(root, 'package.json');
  let cached;
  return {
    root,
    name: readJson(manifestPath).name,
    resolve(subpath) {
      const mtime = fs.statSync(manifestPath).mtimeMs;
      if (cached?.mtime !== mtime)
        cached = { mtime, exports: readJson(manifestPath).exports ?? {} };
      return exportTarget(root, cached.exports, subpath);
    },
  };
}

function withLocalSources(config, projectRoot) {
  if (process.env.NODE_ENV === 'production' || process.env.CI || !process.argv.includes('start')) {
    throw new Error(
      'OXY_LOCAL_BLOOM_SOURCE / OXY_LOCAL_PEABLE_SDK_SOURCE are for an interactive `expo start` ' +
        'only (no production, export or CI). Unset them.',
    );
  }

  const bloomRoot = checkoutRoot('OXY_LOCAL_BLOOM_SOURCE', process.env.OXY_LOCAL_BLOOM_SOURCE);
  const sdkRoot = checkoutRoot(
    'OXY_LOCAL_PEABLE_SDK_SOURCE',
    process.env.OXY_LOCAL_PEABLE_SDK_SOURCE,
  );
  const packages = new Map();
  const roots = [];

  if (bloomRoot) {
    const bloom = fs.existsSync(path.join(bloomRoot, 'package.json')) && localPackage(bloomRoot);
    if (bloom?.name !== '@oxy.so/bloom') {
      throw new Error(
        `OXY_LOCAL_BLOOM_SOURCE=${bloomRoot} is not a Bloom checkout (its package.json must be @oxy.so/bloom)`,
      );
    }
    packages.set(bloom.name, bloom);
    // Bloom's sibling packages with a JavaScript entry (bloom-text, bloom-editor).
    // bloom-lens is native only: its Android code comes from the installed copy.
    const siblingsDir = path.join(bloomRoot, 'packages');
    for (const dir of fs.existsSync(siblingsDir) ? fs.readdirSync(siblingsDir) : []) {
      const manifest = path.join(siblingsDir, dir, 'package.json');
      if (!fs.existsSync(manifest) || !readJson(manifest).exports) continue;
      const sibling = localPackage(path.join(siblingsDir, dir));
      if (sibling.name?.startsWith('@oxy.so/bloom-')) packages.set(sibling.name, sibling);
    }
    roots.push(bloomRoot);
  }

  const sdkFiles = new Map();
  if (sdkRoot) {
    const checkout = path.join(sdkRoot, 'src/checkout.ts');
    const checkoutUi = path.join(sdkRoot, 'src/ui/index.ts');
    if (!fs.existsSync(checkout) || !fs.existsSync(checkoutUi)) {
      throw new Error('OXY_LOCAL_PEABLE_SDK_SOURCE is not the Peable packages/sdk directory');
    }
    sdkFiles.set('@peable.to/sdk/checkout', checkout);
    sdkFiles.set('@peable.to/sdk/checkout/ui', checkoutUi);
    roots.push(sdkRoot);
  }

  config.watchFolders = [...new Set([...config.watchFolders, ...roots])];
  config.resolver.blockList = [
    ...[].concat(config.resolver.blockList || []),
    ...roots.map(
      (root) =>
        new RegExp(
          `^${escapeRegExp(root)}[/\\\\](?:packages[/\\\\][^/\\\\]+[/\\\\])?(?:${BLOCKED_DIRS.map(escapeRegExp).join('|')})(?:[/\\\\]|$)`,
        ),
    ),
  ];

  const parentResolve = config.resolver.resolveRequest;
  const appOrigin = path.join(projectRoot, 'package.json');
  const rootPrefixes = roots.map((root) => root + path.sep);

  function localFile(moduleName) {
    if (sdkFiles.has(moduleName)) return sdkFiles.get(moduleName);
    const scoped = moduleName.split('/');
    const name = scoped.slice(0, 2).join('/');
    const local = packages.get(name);
    if (!local) return null;
    const subpath = scoped.length > 2 ? `./${scoped.slice(2).join('/')}` : '.';
    const target = local.resolve(subpath);
    if (!target) throw new Error(`${moduleName} is not exported by the local ${local.root}`);
    return target;
  }

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = parentResolve || context.resolveRequest;
    const file = localFile(moduleName);
    if (file) return resolve(context, file, platform);
    const fromCheckout = rootPrefixes.some((root) => context.originModulePath.startsWith(root));
    const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
    return resolve(
      fromCheckout && bare ? { ...context, originModulePath: appOrigin } : context,
      moduleName,
      platform,
    );
  };

  const names = [...packages.keys(), ...sdkFiles.keys()].join(', ');
  console.log(`[metro] Local sources: ${names} from ${roots.join(', ')}`);
  return config;
}

module.exports = { withLocalSources, exportTarget };
