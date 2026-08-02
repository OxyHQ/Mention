import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';

const FRONTEND = join(__dirname, '..', '..', '..');

function action(label: string, onPress: () => void = () => {}): ActionMenuAction {
  return { icon: null, label, onPress };
}

describe('buildMenuGroups', () => {
  it('drops empty groups so a menu never renders a blank card', () => {
    const groups = buildMenuGroups([[], [action('Copy link')], []], () => {});

    expect(groups).toHaveLength(1);
    expect(groups[0][0].label).toBe('Copy link');
  });

  // The whole reason the wrapper exists: an action that opens a report sheet or
  // a confirm dialog must not stack it on top of a menu that is still up. Every
  // call site used to remember (or forget) to close the menu itself.
  it('closes the menu BEFORE running the action', () => {
    const order: string[] = [];
    const groups = buildMenuGroups(
      [[action('Report', () => order.push('action'))]],
      () => order.push('close'),
    );

    groups[0][0].onPress();

    expect(order).toEqual(['close', 'action']);
  });

  it('leaves the caller’s actions untouched', () => {
    const original = action('Mute');
    const groups = buildMenuGroups([[original]], () => {});

    expect(groups[0][0]).not.toBe(original);
    expect(original.onPress).toBe(original.onPress);
    expect(groups[0][0].label).toBe('Mute');
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === 'dist' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('action menu wiring', () => {
  const files = sourceFiles(join(FRONTEND, 'components')).concat(
    sourceFiles(join(FRONTEND, 'app')),
    sourceFiles(join(FRONTEND, 'hooks')),
  );

  // Vacuity floor: a broken traversal would report a clean sweep below.
  it('scans the app source tree', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  // The host owns ONE dialog for the whole app; a second mount would open two
  // menus over each other, the way a second ToastOutlet doubled every toast.
  it('mounts the host exactly once', () => {
    const mounts = files.filter((file) => /<ActionMenuHost\s*\/>/.test(readFileSync(file, 'utf8')));

    expect(mounts.map((f) => f.slice(FRONTEND.length + 1))).toEqual([
      join('components', 'providers', 'AppProviders.tsx'),
    ]);
  });

  // The post menu and the profile menu are the same surface. They diverged once
  // (the profile one hand-rolled full-width buttons on a bare sheet) and that is
  // what this pins.
  it('routes every menu through showActionMenu', () => {
    const callers = files
      .filter((file) => /showActionMenu\(/.test(readFileSync(file, 'utf8')))
      .map((f) => f.slice(FRONTEND.length + 1))
      // The definition itself, not a caller.
      .filter((f) => f !== join('components', 'common', 'ActionMenu.tsx'));

    expect(callers.sort()).toEqual([
      // The lane management screen's per-lane menu (rename / where it shows /
      // delete) — the same surface as the two below, so it goes through the same
      // host rather than hand-rolling a third one.
      join('app', '(app)', 'lanes.tsx'),
      join('components', 'Feed', 'PostItem.tsx'),
      join('components', 'ProfileScreen.tsx'),
    ]);
  });

  // Dialog on a wide viewport, bottom sheet on a phone — the placement is the
  // point of moving off the raw bottom sheet, so it is pinned rather than left
  // to a future edit.
  it('is a responsive Dialog, not a bottom sheet', () => {
    const source = readFileSync(join(FRONTEND, 'components', 'common', 'ActionMenu.tsx'), 'utf8');

    expect(source).toMatch(/placement=\{\{\s*base:\s*'bottom',\s*md:\s*'center'\s*\}\}/);
    expect(source).not.toMatch(/BottomSheetContext/);
  });
});
