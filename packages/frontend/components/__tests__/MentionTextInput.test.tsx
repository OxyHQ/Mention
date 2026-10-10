import { useState } from 'react';
import { Platform, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { logger } from '@oxy.so/core/logger';
import MentionTextInput from '../MentionTextInput';
import { MentionSearchContext } from '@/context/MentionSearchContext';
import { reconcileMentionTextValue, type MentionTextValue } from '@/utils/mentions';
import {
  createMentionSearchCache,
  type MentionSearchCache,
  type MentionUser,
} from '@/utils/mentionSearch';

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { textTertiary: '#999' },
  }),
}));

const mockOxySearch = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'viewer' },
    oxyServices: { users: { search: mockOxySearch } },
  }),
}));

interface MockPickerProps {
  users: MentionUser[];
  loading: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (user: MentionUser) => void;
}
let mockPickerProps: MockPickerProps | null = null;
jest.mock('../MentionPicker', () => ({
  __esModule: true,
  default: (props: MockPickerProps) => {
    mockPickerProps = props;
    return null;
  },
}));

const alice = {
  userId: 'alice-id',
  username: 'alice',
  displayName: 'Alice',
};
const aliceUser: MentionUser = { id: 'alice-id', username: 'alice', displayName: 'Alice' };
const aliciaUser: MentionUser = { id: 'alicia-id', username: 'alicia' };

let latestState: MentionTextValue;

function ControlledInput({ initial }: { initial?: MentionTextValue }) {
  const [state, setState] = useState<MentionTextValue>(
    initial ?? { text: 'Hello [mention:alice-id]', mentions: [alice] },
  );
  latestState = state;
  return (
    <MentionTextInput
      value={state.text}
      mentions={state.mentions}
      onValueChange={(next) => setState(reconcileMentionTextValue(next))}
    />
  );
}

const EMPTY: MentionTextValue = { text: '', mentions: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderInSession(cache: MentionSearchCache, initial: MentionTextValue = EMPTY) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <MentionSearchContext.Provider value={cache}>
        <ControlledInput initial={initial} />
      </MentionSearchContext.Provider>,
    );
  });
  return renderer;
}

function type(renderer: TestRenderer.ReactTestRenderer, text: string) {
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText(text);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockOxySearch.mockReset();
  mockPickerProps = null;
});

describe('MentionTextInput controlled mention state', () => {
  it('cannot resurrect a deleted mention from stale child metadata', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ControlledInput />);
    });

    let input = renderer.root.findByType(TextInput);
    expect(input.props.value).toBe('Hello @alice');

    act(() => {
      input.props.onChangeText('Hello');
    });
    expect(latestState).toEqual({ text: 'Hello', mentions: [] });

    input = renderer.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Hello @alice');
    });
    expect(latestState).toEqual({
      text: 'Hello @alice',
      mentions: [],
    });
    expect(mockOxySearch).not.toHaveBeenCalled();
  });
});

describe('MentionTextInput typed handles', () => {
  it('selects the exact match the picker already found as soon as a space follows', async () => {
    const fetchUsers = jest.fn(async () => [aliciaUser, aliceUser]);
    const cache = createMentionSearchCache(fetchUsers);
    // What the picker did while the author typed `@alice`.
    await cache.search('alice');

    const renderer = renderInSession(cache);
    type(renderer, 'Hi @Alice ');

    expect(latestState).toEqual({ text: 'Hi [mention:alice-id] ', mentions: [alice] });
    expect(renderer.root.findByType(TextInput).props.value).toBe('Hi @alice ');
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  it('looks a completed handle up once, and applies it to what the author has typed since', async () => {
    const request = deferred<MentionUser[]>();
    const fetchUsers = jest.fn(() => request.promise);
    const renderer = renderInSession(createMentionSearchCache(fetchUsers));

    type(renderer, 'Hi @alice ');
    type(renderer, 'Hi @alice t');
    type(renderer, 'Hi @alice to');
    expect(fetchUsers).toHaveBeenCalledTimes(1);
    expect(fetchUsers).toHaveBeenCalledWith('alice');
    expect(latestState).toEqual({ text: 'Hi @alice to', mentions: [] });

    request.resolve([aliceUser]);
    await flush();

    expect(latestState).toEqual({ text: 'Hi [mention:alice-id] to', mentions: [alice] });
    expect(renderer.root.findByType(TextInput).props.value).toBe('Hi @alice to');
  });

  it('leaves the text alone when no account matches exactly, and does not ask again', async () => {
    const fetchUsers = jest.fn(async () => [aliciaUser]);
    const renderer = renderInSession(createMentionSearchCache(fetchUsers));

    type(renderer, 'Hi @alice ');
    await flush();
    type(renderer, 'Hi @alice and');
    await flush();

    expect(latestState).toEqual({ text: 'Hi @alice and', mentions: [] });
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  it('leaves handles inside URLs and emails, and federated handles, untouched', async () => {
    const fetchUsers = jest.fn(async () => [aliceUser]);
    const renderer = renderInSession(createMentionSearchCache(fetchUsers));

    const text = 'see https://x.com/@alice and bob@alice.com or @alice@example.com ';
    type(renderer, text);
    await flush();

    expect(latestState).toEqual({ text, mentions: [] });
    expect(fetchUsers).not.toHaveBeenCalled();
  });

  it("offers the session cache's results for the handle being typed", async () => {
    const fetchUsers = jest.fn(async () => [aliceUser, aliciaUser]);
    const cache = createMentionSearchCache(fetchUsers);
    await cache.search('al');
    const renderer = renderInSession(cache);

    act(() => {
      renderer.root.findByType(TextInput).props.onSelectionChange({
        nativeEvent: { selection: { start: 6, end: 6 } },
      });
    });
    type(renderer, 'Hi @al');

    expect(mockPickerProps?.users).toEqual([aliceUser, aliciaUser]);
    expect(mockPickerProps?.loading).toBe(false);
    expect(mockPickerProps?.activeIndex).toBe(0);
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  describe('the picker keyboard, on web', () => {
    const originalOS = Platform.OS;
    const globals = globalThis as { HTMLElement?: unknown };
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
      // The web auto-grow reads the DOM node behind the field; this environment
      // renders native, so there is none to find.
      globals.HTMLElement = class {};
    });
    afterEach(() => {
      Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
      delete globals.HTMLElement;
    });

    async function openPicker() {
      const cache = createMentionSearchCache(jest.fn(async () => [aliceUser, aliciaUser]));
      await cache.search('al');
      const renderer = renderInSession(cache);
      act(() => {
        renderer.root.findByType(TextInput).props.onSelectionChange({
          nativeEvent: { selection: { start: 6, end: 6 } },
        });
      });
      type(renderer, 'Hi @al');
      return renderer;
    }

    function press(renderer: TestRenderer.ReactTestRenderer, key: string) {
      const preventDefault = jest.fn();
      act(() => {
        renderer.root
          .findByType(TextInput)
          .props.onKeyPress({ nativeEvent: { key }, preventDefault });
      });
      return preventDefault;
    }

    it('moves the highlight with the arrows, wrapping, and Enter takes it', async () => {
      const renderer = await openPicker();

      expect(press(renderer, 'ArrowDown')).toHaveBeenCalled();
      expect(mockPickerProps?.activeIndex).toBe(1);
      press(renderer, 'ArrowDown');
      expect(mockPickerProps?.activeIndex).toBe(0);
      press(renderer, 'ArrowUp');
      expect(mockPickerProps?.activeIndex).toBe(1);

      expect(press(renderer, 'Enter')).toHaveBeenCalled();
      expect(latestState).toEqual({
        text: 'Hi [mention:alicia-id] ',
        mentions: [{ userId: 'alicia-id', username: 'alicia', displayName: 'alicia' }],
      });
    });

    it('closes the list on Escape and leaves every key to the field when no list is open', async () => {
      const renderer = await openPicker();
      expect(press(renderer, 'Escape')).toHaveBeenCalled();
      expect(press(renderer, 'Enter')).not.toHaveBeenCalled();
      expect(latestState).toEqual({ text: 'Hi @al', mentions: [] });
    });
  });

  it('leaves Enter to the field on native, where return cannot be prevented', async () => {
    const cache = createMentionSearchCache(jest.fn(async () => [aliceUser]));
    await cache.search('al');
    const renderer = renderInSession(cache);
    act(() => {
      renderer.root.findByType(TextInput).props.onSelectionChange({
        nativeEvent: { selection: { start: 6, end: 6 } },
      });
    });
    type(renderer, 'Hi @al');
    const preventDefault = jest.fn();
    act(() => {
      renderer.root
        .findByType(TextInput)
        .props.onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(latestState).toEqual({ text: 'Hi @al', mentions: [] });
  });

  it('searches Oxy itself outside a composer session', async () => {
    mockOxySearch.mockResolvedValue({
      data: [{ id: 'alice-id', username: 'alice', name: { displayName: 'Alice' } }],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ControlledInput initial={EMPTY} />);
    });

    type(renderer, '@alice, hi');
    await flush();

    expect(mockOxySearch).toHaveBeenCalledWith('alice', { limit: 10 });
    expect(latestState).toEqual({ text: '[mention:alice-id], hi', mentions: [alice] });
  });

  it('drops a lookup that fails or outlives the input', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const failing = deferred<MentionUser[]>();
    const renderer = renderInSession(createMentionSearchCache(() => failing.promise));
    type(renderer, 'Hi @alice ');
    failing.reject(new Error('offline'));
    await flush();
    expect(latestState).toEqual({ text: 'Hi @alice ', mentions: [] });
    expect(warn).toHaveBeenCalledWith(
      'Typed mention lookup failed',
      expect.objectContaining({ handle: 'alice' }),
    );

    const late = deferred<MentionUser[]>();
    const onValueChange = jest.fn();
    let other!: TestRenderer.ReactTestRenderer;
    act(() => {
      other = TestRenderer.create(
        <MentionSearchContext.Provider value={createMentionSearchCache(() => late.promise)}>
          <MentionTextInput value="" mentions={[]} onValueChange={onValueChange} />
        </MentionSearchContext.Provider>,
      );
    });
    act(() => {
      other.root.findByType(TextInput).props.onChangeText('Hi @alice ');
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    act(() => other.unmount());
    late.resolve([aliceUser]);
    await flush();
    expect(onValueChange).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
