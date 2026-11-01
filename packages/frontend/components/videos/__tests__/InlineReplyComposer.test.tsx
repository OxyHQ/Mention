import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { InlineReplyComposer } from '../InlineReplyComposer';

let mockSessionEpoch = 1;
const mockCreateReply = jest.fn();
const mockToast = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ sessionClient: null, sessionMode: 'account' }),
  useAuth: () => ({
    user: { id: 'a' },
    canUsePrivateApi: true,
    oxyServices: {
      http: { getSessionEpoch: () => mockSessionEpoch },
      session: { userId: 'a', isAuthenticated: true },
    },
  }),
}));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: { createReply: typeof mockCreateReply }) => unknown) =>
    selector({ createReply: mockCreateReply }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#000' } }),
}));
jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => '#fff' }));
jest.mock('@oxy.so/bloom/divider', () => ({ Divider: () => null }));
jest.mock('@oxy.so/bloom/textarea', () => ({
  Textarea: (props: object) => {
    const MockInput = jest.requireActual('react-native').TextInput;
    return <MockInput {...props} />;
  },
}));
jest.mock('@oxy.so/bloom/icons/RiSendPlaneLine', () => ({ RiSendPlaneLine: () => null }));

beforeEach(() => {
  mockSessionEpoch = 1;
  mockCreateReply.mockReset();
  mockToast.mockReset();
});

it.each(['success', 'failure'] as const)(
  'does not update the incoming viewer when a reply finishes with %s',
  async (outcome) => {
    let complete!: () => void;
    let fail!: (error: Error) => void;
    mockCreateReply.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          complete = () => resolve({ id: 'reply' });
          fail = reject;
        }),
    );
    const onPosted = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<InlineReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
    });
    mockSessionEpoch += 1;
    await act(async () => {
      if (outcome === 'success') complete();
      else fail(new Error('unknown outcome'));
      await Promise.resolve();
    });
    expect(onPosted).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  },
);

it.each(['success', 'failure'] as const)(
  'allows another reply after a same-viewer session change and an earlier %s',
  async (outcome) => {
    let complete!: () => void;
    let fail!: (error: Error) => void;
    mockCreateReply.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          complete = () => resolve({ id: 'reply' });
          fail = reject;
        }),
    );
    mockCreateReply.mockResolvedValueOnce({ id: 'new-reply' });
    const onPosted = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<InlineReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
    });
    mockSessionEpoch += 1;
    await act(async () => {
      if (outcome === 'success') complete();
      else fail(new Error('unknown outcome'));
      await Promise.resolve();
    });
    expect(onPosted).not.toHaveBeenCalled();
    await act(async () => {
      renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
      await Promise.resolve();
    });
    expect(mockCreateReply).toHaveBeenCalledTimes(2);
    expect(onPosted).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  },
);

it('warns of an unconfirmed reply without retrying automatically', async () => {
  mockCreateReply.mockRejectedValue(new Error('unknown outcome'));
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<InlineReplyComposer postId="p" onPosted={jest.fn()} />);
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('hello');
  });
  await act(async () => {
    renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
    await Promise.resolve();
  });
  expect(mockCreateReply).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledWith(
    expect.stringMatching(/replyUnconfirmed|confirm.*reply/i),
    { type: 'error' },
  );
  expect(renderer.root.findByType(TextInput).props.value).toBe('hello');
  act(() => renderer.unmount());
});

it.each(['later reply', 'hello'])(
  'keeps the edit made during a pending reply, including editing back to the original text (%s)',
  async (newText) => {
    let complete!: () => void;
    mockCreateReply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ id: 'reply' });
        }),
    );
    const onPosted = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<InlineReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('temporary');
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText(newText);
    });
    await act(async () => {
      complete();
      await Promise.resolve();
    });
    expect(renderer.root.findByType(TextInput).props.value).toBe(newText);
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  },
);

it('does not report uncertainty if a local callback fails after a confirmed reply', async () => {
  let complete!: () => void;
  mockCreateReply.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ id: 'reply' });
      }),
  );
  const onPosted = jest.fn(() => {
    throw new Error('local callback failed');
  });
  const { logger } = jest.requireActual('@oxy.so/core/logger');
  const report = jest.spyOn(logger, 'error').mockImplementation(() => {});
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<InlineReplyComposer postId="p" onPosted={onPosted} />);
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('first');
  });
  act(() => {
    renderer.root.find((node) => typeof node.props.onPress === 'function').props.onPress();
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('later edit');
  });
  await act(async () => {
    complete();
    await Promise.resolve();
  });
  expect(renderer.root.findByType(TextInput).props.value).toBe('later edit');
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockCreateReply).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalled();
  act(() => renderer.unmount());
  report.mockRestore();
});
