import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import VideoPosterCell from '../VideoPosterCell';

/**
 * The metadata row is the only place in the app where a play count and a
 * duration are rendered from two sources that disagree about how they spell
 * "zero", so the states are pinned individually rather than sampled.
 *
 * `render` awaits an async act because `Ionicons` resolves its font in a
 * promise and updates after mount; without the flush every assertion here would
 * be made against a half-mounted tree.
 */
async function render(props: React.ComponentProps<typeof VideoPosterCell>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<VideoPosterCell {...props} />);
  });
  return renderer;
}

/** Teardown is a React update like any other, so it needs the same act wrapper. */
function unmount(...renderers: TestRenderer.ReactTestRenderer[]) {
  act(() => {
    renderers.forEach((renderer) => renderer.unmount());
  });
}

function hostNodes(renderer: TestRenderer.ReactTestRenderer, type: 'Text' | 'View') {
  // Compared as a string because `ElementType`'s own string branch enumerates
  // DOM intrinsics, which react-native's host names are not part of. A component
  // stringifies to its source, so it can never collide with a host name.
  return renderer.root.findAll((node) => String(node.type) === type, { deep: true });
}

/**
 * The strings the cell paints as LABELS. An icon glyph is also a host `Text`,
 * and it is the only one with no `className`, so that is the discriminator —
 * matching on the glyph character instead would depend on the icon font having
 * loaded.
 */
function labels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return hostNodes(renderer, 'Text')
    .filter((node) => typeof (node.props as { className?: unknown }).className === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
}

function iconNames(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Ionicons)
    .map((node) => String((node.props as { name: unknown }).name));
}

const BASE = { posterUri: 'https://cdn.example/poster.jpg', size: 120, placeholderColor: '#888' };

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('VideoPosterCell metadata row', () => {
  it('renders the compact count and the duration when both are present', async () => {
    const renderer = await render({ ...BASE, views: 1234, durationSec: 42 });
    expect(labels(renderer)).toEqual(['1.2K', '0:42']);
    unmount(renderer);
  });

  it('renders the count alone when the item carries no duration', async () => {
    const renderer = await render({ ...BASE, views: 1234 });
    expect(labels(renderer)).toEqual(['1.2K']);
    unmount(renderer);
  });

  it('renders the duration alone when the post has no views', async () => {
    const renderer = await render({ ...BASE, views: 0, durationSec: 42 });
    expect(labels(renderer)).toEqual(['0:42']);
    unmount(renderer);
  });

  it('renders neither when the post has no views and the item no duration', async () => {
    const renderer = await render(BASE);
    expect(labels(renderer)).toEqual([]);
    unmount(renderer);
  });

  /**
   * `0:00` claims a length the clip does not have, so a zero duration is absent
   * rather than formatted. `readMediaDurationSec` already rejects `<= 0` on
   * every path into this component today — this pins the component's OWN guard,
   * which is what the next caller will actually be relying on.
   */
  it('treats a 0 duration as absent, never rendering 0:00', async () => {
    const zero = await render({ ...BASE, views: 12, durationSec: 0 });
    const absent = await render({ ...BASE, views: 12 });

    expect(labels(zero)).toEqual(labels(absent));
    expect(labels(zero)).not.toContain('0:00');

    unmount(zero, absent);
  });

  /**
   * The most valuable assertion in this file. `views_count` is a numeric SQLite
   * column and `db/schema.ts` reads it back as `row.views_count ?? null`, so a
   * zero-view post arrives as `0` on native but as `null` on web, where
   * `db/memoryStore.ts` hands the server object back by reference. A `!== null`
   * predicate would print "0" under every video on iOS/Android and nothing at
   * all on web, and no single-platform test run would show it.
   */
  it('treats 0, null and undefined views identically', async () => {
    const zero = await render({ ...BASE, views: 0, durationSec: 42 });
    const nulled = await render({ ...BASE, views: null, durationSec: 42 });
    const absent = await render({ ...BASE, durationSec: 42 });

    expect(labels(zero)).toEqual(labels(nulled));
    expect(labels(nulled)).toEqual(labels(absent));
    expect(iconNames(zero)).toEqual(iconNames(nulled));

    unmount(zero, nulled, absent);
  });

  /**
   * Regression guard for the two affordances this row replaced — a centered
   * `play-circle` on the media grid and a corner `play` chip on the videos grid.
   * A second glyph reads badly on a ~120px cell, which is why they were removed;
   * zero glyphs would leave a video cell with no video marker at all.
   */
  it('paints exactly one play glyph, in both scrim modes', async () => {
    const scrimmed = await render({ ...BASE, scrim: true, views: 12, durationSec: 5 });
    const plain = await render({ ...BASE, views: 12, durationSec: 5 });

    expect(iconNames(scrimmed)).toEqual(['play']);
    expect(iconNames(plain)).toEqual(['play']);

    unmount(scrimmed, plain);
  });

  it('adds exactly one view for the scrim and nothing else', async () => {
    const scrimmed = await render({ ...BASE, scrim: true, views: 12, durationSec: 5 });
    const plain = await render({ ...BASE, views: 12, durationSec: 5 });

    expect(hostNodes(scrimmed, 'View')).toHaveLength(hostNodes(plain, 'View').length + 1);
    expect(labels(scrimmed)).toEqual(labels(plain));

    unmount(scrimmed, plain);
  });

  it('keeps the metadata row out of the grid cell\'s tap target', async () => {
    const renderer = await render({ ...BASE, views: 12, durationSec: 5 });
    const row = hostNodes(renderer, 'View').find(
      (node) => (node.props as { pointerEvents?: string }).pointerEvents === 'none',
    );
    // Both grids wrap this cell in a TouchableOpacity, so an overlay that
    // accepted touches would eat the tap along the bottom strip.
    expect(row).toBeDefined();
    unmount(renderer);
  });
});

describe('VideoPosterCell poster fallback', () => {
  it('falls back to the placeholder icon when the poster fails to load', async () => {
    const renderer = await render(BASE);
    expect(renderer.root.findAllByType(Image)).toHaveLength(1);

    await act(async () => {
      renderer.root.findByType(Image).props.onError();
    });

    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(iconNames(renderer)).toContain('videocam-outline');
    unmount(renderer);
  });

  /**
   * The failure is per-URI. It is cleared during render rather than in an
   * effect, so a recycled cell never commits one frame of the previous poster's
   * placeholder before recovering.
   */
  it('clears the failure when a new poster URI arrives', async () => {
    const renderer = await render(BASE);
    await act(async () => {
      renderer.root.findByType(Image).props.onError();
    });
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);

    await act(async () => {
      renderer.update(
        <VideoPosterCell {...BASE} posterUri="https://cdn.example/other.jpg" />,
      );
    });

    expect(renderer.root.findAllByType(Image)).toHaveLength(1);
    expect(iconNames(renderer)).not.toContain('videocam-outline');
    unmount(renderer);
  });
});
