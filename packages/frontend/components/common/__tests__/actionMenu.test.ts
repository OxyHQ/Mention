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
    const groups = buildMenuGroups([[action('Report', () => order.push('action'))]], () =>
      order.push('close'),
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

  it('does not execute an action after its owner aborts', () => {
    const owner = new AbortController();
    const close = jest.fn();
    const run = jest.fn();
    const groups = buildMenuGroups([[action('Delete', run)]], close, owner.signal);
    owner.abort();
    groups[0][0].onPress();
    expect(close).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not execute an action if closing crosses its session boundary', () => {
    const owner = new AbortController();
    const run = jest.fn();
    const groups = buildMenuGroups([[action('Delete', run)]], () => owner.abort(), owner.signal);
    groups[0][0].onPress();
    expect(run).not.toHaveBeenCalled();
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === '__tests__' ||
      entry === '.expo' ||
      entry === 'dist' ||
      entry.startsWith('.')
    ) {
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

  // The ⋯ buttons (post, profile, trend, room) render through
  // `ActionMenuTrigger`, Bloom's DropdownMenu; what is left on `showActionMenu`
  // are the menus opened from something that is not a button.
  it('routes every imperative menu through showActionMenu', () => {
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
      join('components', 'Feed', 'showRepostMenu.tsx'),
      // Opening Allo (a profile's Message, a post's Send) when it is not
      // installed: get Allo, or open it on the web (#1140).
      join('hooks', 'useOpenInAllo.tsx'),
    ]);
  });

  it('uses an owned menu for notification long presses', () => {
    const source = readFileSync(
      join(FRONTEND, 'components', 'notifications', 'NotificationItem.tsx'),
      'utf8',
    );
    expect(source).toMatch(/showCancelableActionMenu\(/);
  });

  // Dialog on a wide viewport, bottom sheet on a phone — the placement is the
  // point of moving off the raw bottom sheet, so it is pinned rather than left
  // to a future edit.
  // Presented on Bloom's one surface stack (no app-local host to mount twice),
  // as a responsive Dialog: a centered card from md up, a sheet below.
  it('is a responsive surface, presented like every other sheet', () => {
    const source = readFileSync(join(FRONTEND, 'components', 'common', 'ActionMenu.tsx'), 'utf8');

    expect(source).toMatch(/presentSheet\(/);
  });
});
