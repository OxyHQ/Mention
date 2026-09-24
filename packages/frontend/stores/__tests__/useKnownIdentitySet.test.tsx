import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  mergeKnownIdentity,
  reconcileKnownIdentities,
  recordIdentityChange,
  resetIdentityUpdates,
  useKnownIdentitySet,
  type IdentityUpdate,
} from '../identityUpdates';

/**
 * The keyed read of the overlay. A mounted feed holds dozens of rows, each
 * showing a handful of actors; one profile edit must repaint the rows that show
 * THAT person and leave every other row alone. These tests count renders to pin
 * exactly that, alongside the retirement semantics the rows depend on.
 */

type Actor = { id: string; avatar?: string };

const renders: Record<string, number> = {};
const seen: Record<string, ReadonlyMap<string, IdentityUpdate>[]> = {};

/** The render-count probe. Called during render, so each call is one render. */
function probe(name: string, identities: ReadonlyMap<string, IdentityUpdate>): void {
  renders[name] = (renders[name] ?? 0) + 1;
  (seen[name] ??= []).push(identities);
}

function Row({
  name,
  actors,
  onRender = probe,
}: {
  name: string;
  actors: readonly (string | undefined)[];
  onRender?: typeof probe;
}) {
  const identities = useKnownIdentitySet(actors);
  onRender(name, identities);
  const avatars = actors
    .filter((id): id is string => Boolean(id))
    .map((id) => mergeKnownIdentity<Actor>({ id, avatar: 'server' }, identities.get(id)).avatar)
    .join(',');
  return React.createElement('row', { rowName: name }, avatars);
}

const Memo = React.memo(Row);

let renderer: TestRenderer.ReactTestRenderer | null = null;

function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

function text(name: string): string {
  const node = renderer!.root.find((n) => (n.type as unknown) === 'row' && n.props.rowName === name);
  return node.children.join('');
}

beforeEach(() => {
  for (const key of Object.keys(renders)) delete renders[key];
  for (const key of Object.keys(seen)) delete seen[key];
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  resetIdentityUpdates();
});

function feed() {
  return (
    <>
      <Memo name="a" actors={['A']} />
      <Memo name="ab" actors={['A', 'B']} />
      <Memo name="bc" actors={['B', 'C']} />
      <Memo name="c" actors={['C', undefined]} />
    </>
  );
}

describe('useKnownIdentitySet', () => {
  it('re-renders only the rows that show the edited identity', () => {
    mount(feed());
    expect(renders).toEqual({ a: 1, ab: 1, bc: 1, c: 1 });

    act(() => {
      recordIdentityChange({ id: 'A', avatar: 'edited' });
    });

    expect(renders).toEqual({ a: 2, ab: 2, bc: 1, c: 1 });
    expect(text('a')).toBe('edited');
    expect(text('ab')).toBe('edited,server');
    expect(text('bc')).toBe('server,server');
  });

  it('returns a stable reference while none of its ids change', () => {
    mount(<Row name="bc" actors={['B', 'C']} />);
    act(() => {
      recordIdentityChange({ id: 'B', avatar: 'b1' });
    });
    act(() => {
      recordIdentityChange({ id: 'Z', avatar: 'z1' });
    });
    // A parent re-render with a new (but equal) id array keeps the same map.
    act(() => {
      renderer!.update(<Row name="bc" actors={['B', 'C']} />);
    });

    const maps = seen.bc;
    expect(maps).toHaveLength(3); // mount, the B write, the parent update — not the Z write
    expect(maps[2]).toBe(maps[1]);
    expect(maps[1].get('B')?.avatar).toBe('b1');
    expect(maps[1].has('Z')).toBe(false);
  });

  it('hands out one shared empty map to rows nobody has edited', () => {
    mount(feed());
    act(() => {
      recordIdentityChange({ id: 'A', avatar: 'edited' });
    });
    expect(seen.bc[0]).toBe(seen.c[0]);
    expect(seen.bc[0].size).toBe(0);
  });

  it('follows a change in the number of actors a row shows', () => {
    recordIdentityChange({ id: 'C', avatar: 'c1' });
    mount(<Row name="row" actors={['A']} />);
    expect(text('row')).toBe('server');

    act(() => {
      renderer!.update(<Row name="row" actors={['A', 'B', 'C']} />);
    });
    expect(text('row')).toBe('server,server,c1');

    // Now subscribed to B as well.
    act(() => {
      recordIdentityChange({ id: 'B', avatar: 'b1' });
    });
    expect(text('row')).toBe('server,b1,c1');

    act(() => {
      renderer!.update(<Row name="row" actors={['A']} />);
    });
    const before = renders.row;
    // No longer subscribed to C.
    act(() => {
      recordIdentityChange({ id: 'C', avatar: 'c2' });
    });
    expect(renders.row).toBe(before);
    expect(text('row')).toBe('server');
  });

  it('ignores duplicate ids', () => {
    mount(<Row name="dup" actors={['A', 'A', undefined, 'A']} />);
    act(() => {
      recordIdentityChange({ id: 'A', avatar: 'edited' });
    });
    expect(renders.dup).toBe(2);
    expect(text('dup')).toBe('edited,edited,edited');
  });

  it('hands a row with no actors the shared empty map and never wakes it', () => {
    mount(
      <>
        {feed()}
        <Memo name="none" actors={[undefined]} />
      </>,
    );
    act(() => {
      recordIdentityChange({ id: 'A', avatar: 'edited' });
    });
    expect(renders.none).toBe(1);
    expect(seen.none[0].size).toBe(0);
  });

  it('skips an actor without an id when reconciling', () => {
    recordIdentityChange({ id: 'A', avatar: 'edited' });
    mount(<Row name="a" actors={['A']} />);
    act(() => {
      reconcileKnownIdentities([
        { id: '', avatar: 'edited' },
        { id: 'unrecorded', avatar: 'edited' },
      ]);
    });
    expect(renders.a).toBe(1);
    expect(text('a')).toBe('edited');
  });

  it('keeps the fields an agreeing actor could not answer for', () => {
    recordIdentityChange({
      id: 'A',
      username: 'a',
      avatar: 'edited',
      bio: 'bio',
      name: { displayName: 'A' },
      accountCategories: ['news'],
    });
    recordIdentityChange({ id: 'B', avatar: 'b-edited', accountCategories: ['news'] });
    mount(<Row name="ab" actors={['A', 'B']} />);

    act(() => {
      reconcileKnownIdentities([
        { id: 'A', accountCategories: ['news'] },
        { id: 'B', avatar: 'b-edited' },
      ]);
    });
    const identities = seen.ab[seen.ab.length - 1];
    expect(identities.get('A')).toEqual({
      id: 'A',
      username: 'a',
      avatar: 'edited',
      bio: 'bio',
      name: { displayName: 'A' },
    });
    expect(identities.get('B')).toEqual({ id: 'B', accountCategories: ['news'] });
    expect(text('ab')).toBe('edited,server');
  });

  it('propagates retirement to the rows that show the retired identity only', () => {
    recordIdentityChange({ id: 'A', avatar: 'edited' });
    recordIdentityChange({ id: 'B', avatar: 'b-edited' });
    mount(feed());
    expect(text('a')).toBe('edited');

    // The server now carries A's new picture: the overlay entry retires, and the
    // rows fall back to whatever their embedded copy says.
    act(() => {
      reconcileKnownIdentities([{ id: 'A', avatar: 'edited' }]);
    });
    expect(renders).toEqual({ a: 2, ab: 2, bc: 1, c: 1 });
    expect(seen.a[1].size).toBe(0);
    expect(text('a')).toBe('server');
    expect(text('ab')).toBe('server,b-edited');
  });

  it('wakes every subscribed row on a reset', () => {
    recordIdentityChange({ id: 'A', avatar: 'edited' });
    recordIdentityChange({ id: 'C', avatar: 'c-edited' });
    mount(feed());

    act(() => {
      resetIdentityUpdates();
    });
    expect(renders).toEqual({ a: 2, ab: 2, bc: 2, c: 2 });
    expect(text('c')).toBe('server');
  });
});
