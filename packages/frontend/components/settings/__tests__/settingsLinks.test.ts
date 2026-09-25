import fs from 'node:fs';
import path from 'node:path';
import { linkPath, redirectSystemPath } from '@/app/+native-intent';
import { onSettingsRequest, requestSettings } from '../settingsRoutes';

describe('settings links never enter the native stack', () => {
  let unsubscribe: (() => void) | undefined;
  afterEach(() => unsubscribe?.());

  it('reads the path of every link shape the app receives', () => {
    expect(linkPath('mention://settings')).toBe('/settings');
    expect(linkPath('mention://settings/appearance?x=1')).toBe('/settings/appearance?x=1');
    expect(linkPath('https://mention.earth/settings/privacy/blocked')).toBe('/settings/privacy/blocked');
    expect(linkPath('mention:///@nate')).toBe('/@nate');
    expect(linkPath('/settings')).toBe('/settings');
  });

  it('opens the modal in place for a warm link and lands on Home for a cold one', () => {
    const opened: (string | undefined)[] = [];
    unsubscribe = onSettingsRequest((page) => opened.push(page));
    expect(redirectSystemPath({ path: 'mention://settings/appearance', initial: false })).toBeNull();
    expect(redirectSystemPath({ path: 'https://mention.earth/settings', initial: true })).toBe('/');
    expect(opened).toEqual(['appearance', undefined]);
  });

  it('leaves every other link to the router', () => {
    const opened: (string | undefined)[] = [];
    unsubscribe = onSettingsRequest((page) => opened.push(page));
    expect(redirectSystemPath({ path: 'mention://explore', initial: false })).toBe('mention://explore');
    expect(redirectSystemPath({ path: 'https://mention.earth/settings/nope', initial: true })).toBe('https://mention.earth/settings/nope');
    expect(opened).toEqual([]);
  });

  it('holds a cold-start request until the provider mounts', () => {
    expect(requestSettings('/settings/language')).toBe(true);
    const opened: (string | undefined)[] = [];
    unsubscribe = onSettingsRequest((page) => opened.push(page));
    expect(opened).toEqual(['language']);
  });

  it('keeps in-app code from pushing a settings route onto the stack', () => {
    const root = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory)) {
        if (entry === 'node_modules' || entry === '__tests__' || entry === 'android' || entry === 'ios' || entry.startsWith('.')) continue;
        const file = path.join(directory, entry);
        if (fs.statSync(file).isDirectory()) walk(file);
        // Settings pages route through `useSettingsRouter`, which is the modal.
        else if (/\.tsx?$/.test(file) && !file.includes(`${path.sep}components${path.sep}settings${path.sep}pages${path.sep}`)) {
          if (/router\.(push|replace|navigate)\(\s*['"`]\/settings/.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file));
        }
      }
    };
    for (const directory of ['app', 'components', 'hooks', 'lib', 'utils', 'context']) walk(path.join(root, directory));
    expect(offenders).toEqual([]);
  });
});

it('renders the Settings modal outlet inside the settings provider', () => {
  const layout = fs.readFileSync(path.resolve(__dirname, '../../../app/_layout.tsx'), 'utf8');
  const open = layout.indexOf('<MentionSettingsProvider>');
  const outlet = layout.indexOf('<PortalOutlet />');
  const close = layout.indexOf('</MentionSettingsProvider>');
  expect(open).toBeGreaterThan(-1);
  expect(outlet).toBeGreaterThan(open);
  expect(close).toBeGreaterThan(outlet);
});
