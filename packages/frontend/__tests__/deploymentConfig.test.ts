import { execFileSync } from 'node:child_process';
import path from 'node:path';

type Endpoints = { api: string; socket: string; web: string; redirect: string; widget: { apiBaseUrl: string; webBaseUrl: string } };

/**
 * The child gets PATH, HOME and the overrides under test — NOTHING else. That
 * is the point: `config.ts` has to resolve from what a deployment sets, not
 * from whatever this developer's shell happens to be carrying.
 *
 * `NODE_ENV` is named in the signature rather than left to the index signature
 * because Expo declares it REQUIRED on `ProcessEnv` (`expo/types/metro-require.d.ts`),
 * so a bag typed only as `Record<string, string>` cannot satisfy `execFileSync`'s
 * `env`. Every case below already passes it, and the union keeps a typo like
 * `'prod'` from reaching the child as a silently unrecognised mode.
 */
type ConfigOverrides = Record<string, string> & { NODE_ENV: 'development' | 'production' | 'test' };

function evaluateConfig(overrides: ConfigOverrides): Endpoints {
  const root = path.resolve(__dirname, '..');
  const program = `
    import * as client from ${JSON.stringify(path.join(root, 'config.ts'))};
    const { expo } = require(${JSON.stringify(path.join(root, 'app.config.js'))})({});
    const widget = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === './modules/mention-widgets/app.plugin')[1];
    process.stdout.write(JSON.stringify({ api: client.API_URL, socket: client.API_URL_SOCKET,
      web: client.WEB_BASE_URL, redirect: client.OXY_AUTH_REDIRECT_URI, widget }));
  `;
  const result = execFileSync('bun', ['--eval', program], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides }, encoding: 'utf8',
  });
  return JSON.parse(result) as Endpoints;
}

describe('per-deployment frontend endpoint binding', () => {
  it.each(['alpha', 'beta'])('does not send production %s traffic to the public instance', (tenant) => {
    const api = `https://api.${tenant}.example`;
    const web = `https://social.${tenant}.example`;
    expect(evaluateConfig({ NODE_ENV: 'production', EXPO_PUBLIC_API_URL: api, EXPO_PUBLIC_WEB_BASE_URL: web }))
      .toEqual({ api, socket: `wss://api.${tenant}.example`, web, redirect: web,
        widget: { apiBaseUrl: api, webBaseUrl: web } });
  });
  it('preserves the public production defaults and localhost development fallback', () => {
    expect(evaluateConfig({ NODE_ENV: 'production' })).toMatchObject({
      api: 'https://api.mention.earth', socket: 'wss://api.mention.earth', web: 'https://mention.earth',
    });
    expect(evaluateConfig({ NODE_ENV: 'development' })).toMatchObject({
      api: 'http://localhost:4110', socket: 'ws://localhost:4110',
    });
  });
  it('honors explicitly registered OAuth callbacks and socket origins', () => {
    expect(evaluateConfig({ NODE_ENV: 'production', EXPO_PUBLIC_API_URL_SOCKET: 'wss://realtime.alpha.example',
      EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI: 'https://social.alpha.example/oauth/callback' }))
      .toMatchObject({ socket: 'wss://realtime.alpha.example', redirect: 'https://social.alpha.example/oauth/callback' });
  });
});
