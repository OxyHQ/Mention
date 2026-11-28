// DEV ONLY: the Metro side of the Bloom language proof app (README.md here).
// Loaded by `metro.config.js` only when `BLOOM_LANG_PROOF=1`.
//
// The notification-settings screen (its `.bloom` port and the two TypeScript
// variants it is measured against) imports three app hooks; for the screen's own files, and nothing else,
// those imports resolve to the deterministic stand-ins in `stand-ins/`, the same
// modules the Jest harness mocks them with.
const path = require('node:path');

const STAND_INS = {
  '@oxy.so/services/ui/client': 'stand-ins/services.ts',
  '@/hooks/useViewerSettings': 'stand-ins/viewerSettings.ts',
  '@/context/MentionSettingsContext': 'stand-ins/settingsRouter.ts',
};

/** The screen files whose imports are redirected (extension stripped). */
const SCREENS = [
  'components/settings/pages/notifications',
  '__perf__/lang-proof/variants/original',
  '__perf__/lang-proof/variants/cleaned',
];

function withProofStandIns(config, projectRoot) {
  const screens = SCREENS.map((screen) => path.join(projectRoot, screen));
  const parentResolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = parentResolve || context.resolveRequest;
    const origin = context.originModulePath.replace(/\.(tsx?|bloom)$/, '');
    const standIn = STAND_INS[moduleName];
    if (standIn && screens.includes(origin)) {
      return resolve(context, path.join(__dirname, standIn), platform);
    }
    return resolve(context, moduleName, platform);
  };
  return config;
}

/**
 * PostItem's TypeScript form for the bytes proof (README.md, "PostItem"): every import of
 * `PostItem.bloom` resolves to `postitem/tsPostItem.ts`, which draws the TS PostItem the
 * `.bloom` module replaced. Loaded by `metro.config.js` only with `BLOOM_PROOF_POSTITEM=ts`.
 */
function withTsPostItem(config) {
  const parentResolve = config.resolver.resolveRequest;
  const shim = path.join(__dirname, 'postitem/tsPostItem.ts');
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = parentResolve || context.resolveRequest;
    if (
      /(^|\/)PostItem\.bloom$/.test(moduleName) &&
      !context.originModulePath.includes('lang-proof/postitem/')
    ) {
      return resolve(context, shim, platform);
    }
    return resolve(context, moduleName, platform);
  };
  return config;
}

module.exports = { withProofStandIns, withTsPostItem };
