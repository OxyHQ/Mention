import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { CompactReplyComposer } from '../CompactReplyComposer';

let mockSessionEpoch = 1;
let mockViewerId: string | null = 'a';
const mockCreateReply = jest.fn();
const mockToast = jest.fn();
const mockOpenMediaPicker = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuthStore: { getState: () => ({ user: mockViewerId ? { id: mockViewerId } : null }) },
  useOxy: () => ({ sessionClient: null, sessionMode: 'account' }),
  useAuth: () => ({
    user: mockViewerId ? { id: mockViewerId } : null,
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

jest.mock('@/lib/navigation/router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('@oxy.so/bloom/collapsible', () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }));
jest.mock('@oxy.so/bloom/page-footer', () => ({
  PageFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@oxy.so/bloom/button', () => ({
  GlyphButton: (props: object) => {
    const { Pressable } = jest.requireActual('react-native');
    return <Pressable {...props} />;
  },
  Button: (props: object) => {
    const { Pressable } = jest.requireActual('react-native');
    return <Pressable {...props} />;
  },
}));

jest.mock('@/hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({ openMediaPicker: mockOpenMediaPicker }),
}));
jest.mock('@/hooks/usePrivateMediaUrls', () => ({ usePrivateMediaUrls: () => () => '' }));
jest.mock('@/components/Compose/ComposeMediaPreview', () => ({ ComposeMediaPreview: () => null }));
jest.mock('@/components/Compose/AttachmentCarouselItem', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@oxy.so/bloom/surface', () => ({
  Surface: jest
    .requireActual('react')
    .forwardRef(({ children }: { children: React.ReactNode }, ref: unknown) => {
      const { View } = jest.requireActual('react-native');
      return <View ref={ref}>{children}</View>;
    }),
}));
jest.mock('@oxy.so/bloom/layout', () => ({
  Toolbar: ({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) => (
    <>
      {children}
      {actions}
    </>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@oxy.so/bloom/stat-bar', () => ({
  MeterRing: (props: object) => {
    const { View } = jest.requireActual('react-native');
    return <View {...props} />;
  },
}));

beforeEach(() => {
  mockSessionEpoch = 1;
  mockViewerId = 'a';
  mockCreateReply.mockReset();
  mockToast.mockReset();
  mockOpenMediaPicker.mockReset();
});

it('reports an unavailable session without sending or clearing a reply', async () => {
  mockViewerId = null;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={jest.fn()} />);
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('hello'));
  await act(async () => {
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
    await Promise.resolve();
  });
  expect(mockToast).toHaveBeenCalled();
  expect(mockCreateReply).not.toHaveBeenCalled();
  expect(renderer.root.findByType(TextInput).props.value).toBe('hello');
  act(() => renderer.unmount());
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
      renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
    });
    mockSessionEpoch += 1;
    mockViewerId = 'b';
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
      renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
    });
    mockSessionEpoch += 1;
    await act(async () => {
      if (outcome === 'success') complete();
      else fail(new Error('unknown outcome'));
      await Promise.resolve();
    });
    expect(onPosted).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringMatching(/replyUnconfirmed|confirm.*reply/i),
      { type: 'error' },
    );
    expect(renderer.root.findByType(TextInput).props.value).toBe('hello');
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
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
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={jest.fn()} />);
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('hello');
  });
  await act(async () => {
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
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

it('finishes a reply normally when a same-context token refresh keeps the epoch', async () => {
  let resolve!: (value: unknown) => void;
  mockCreateReply.mockReturnValueOnce(
    new Promise((finish) => {
      resolve = finish;
    }),
  );
  const onPosted = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('hello');
  });
  act(() => {
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
  });
  // Core retains this epoch for a token rotation within the same session.
  await act(async () => {
    resolve({ id: 'reply' });
    await Promise.resolve();
  });
  expect(onPosted).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockCreateReply).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it.each(['aba', 'logout', 'unmount'] as const)(
  'shows a generic uncertainty warning only to the mounted original viewer after %s',
  async (transition) => {
    let reject!: (error: Error) => void;
    mockCreateReply.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const onPosted = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('private text');
    });
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
    });
    mockSessionEpoch += 1;
    mockViewerId = transition === 'logout' ? null : 'b';
    if (transition === 'aba') {
      mockSessionEpoch += 1;
      mockViewerId = 'a';
    }
    if (transition === 'unmount') act(() => renderer.unmount());
    await act(async () => {
      reject(new Error('unknown outcome'));
      await Promise.resolve();
    });
    if (transition === 'aba') {
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/replyUnconfirmed|confirm.*reply/i),
        { type: 'error' },
      );
      expect(renderer.root.findByType(TextInput).props.value).toBe('private text');
    } else {
      expect(mockToast).not.toHaveBeenCalled();
    }
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    expect(onPosted).not.toHaveBeenCalled();
    if (transition !== 'unmount') act(() => renderer.unmount());
  },
);

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
      renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('hello');
    });
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
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
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onPosted={onPosted} />);
  });
  act(() => {
    renderer.root.findByType(TextInput).props.onChangeText('first');
  });
  act(() => {
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
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

it.each([false, true])(
  'keeps one pending send across presentation remount and preserves subsequent edits=%s',
  async (edit) => {
    const { createReplyDraft } = jest.requireActual('../replyDraft');
    const draft = createReplyDraft(() => true);
    let complete!: () => void;
    mockCreateReply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ id: 'reply' });
        }),
    );
    const onPosted = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    const mount = () =>
      TestRenderer.create(<CompactReplyComposer postId="p" draft={draft} onPosted={onPosted} />);
    act(() => {
      renderer = mount();
    });
    act(() => renderer.root.findByType(TextInput).props.onChangeText('hello'));
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
    });
    act(() => renderer.unmount());
    act(() => {
      renderer = mount();
    });
    expect(renderer.root.findByType(TextInput).props.value).toBe('hello');
    act(() => {
      renderer.root
        .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
        .props.onPress();
    });
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    if (edit) act(() => renderer.root.findByType(TextInput).props.onChangeText('next reply'));
    await act(async () => {
      complete();
      await Promise.resolve();
    });
    expect(renderer.root.findByType(TextInput).props.value).toBe(edit ? 'next reply' : '');
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(draft.store.getState().pending).toBeNull();
    act(() => renderer.unmount());
  },
);

it('does not apply a pending reply to a different route owner after presentation remount', async () => {
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  let active = true;
  const oldDraft = createReplyDraft(() => active);
  const nextDraft = createReplyDraft(() => true);
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
    renderer = TestRenderer.create(
      <CompactReplyComposer postId="p" draft={oldDraft} onPosted={onPosted} />,
    );
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('old reply'));
  act(() => {
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
  });
  active = false;
  act(() => renderer.unmount());
  act(() => {
    renderer = TestRenderer.create(
      <CompactReplyComposer postId="p" draft={nextDraft} onPosted={onPosted} />,
    );
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('new route reply'));
  await act(async () => {
    complete();
    await Promise.resolve();
  });
  expect(renderer.root.findByType(TextInput).props.value).toBe('new route reply');
  expect(onPosted).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(oldDraft.store.getState().pending).toBeNull();
  act(() => renderer.unmount());
});

it('maximizes the exact reply draft once and only clears after Compose acknowledges it', () => {
  const { consumeReplyComposerHandoff } = jest.requireActual('@/utils/replyComposerHandoff');
  const navigate = jest.fn();
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  const draft = createReplyDraft();
  const text = `  <literal> ${'word '.repeat(150)}\n  `;
  draft.store.getState().setText(text);
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <CompactReplyComposer postId="reply-tail" draft={draft} onNavigate={navigate} />,
    );
  });
  act(() =>
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-maximize')[0]
      .props.onPress(),
  );
  const href = new URL(navigate.mock.calls[0][0], 'https://mention.earth');
  expect(href.searchParams.get('replyToPostId')).toBe('reply-tail');
  expect(renderer.root.findByType(TextInput).props.value).toBe(text);
  const scope = { viewerId: 'a', epoch: 1, replyToPostId: 'reply-tail' };
  const incoming = consumeReplyComposerHandoff(href.searchParams.get('replyDraftToken'), scope);
  expect(incoming.text).toBe(text);
  act(() => incoming.acknowledge(scope));
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  act(() => renderer.unmount());
});

it('cannot maximize an in-flight reply into a second publishable draft', () => {
  mockCreateReply.mockImplementation(() => new Promise(() => {}));
  const navigate = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onNavigate={navigate} />);
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('sending'));
  act(() => {
    void renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
  });
  act(() =>
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-maximize')[0]
      .props.onPress(),
  );
  expect(navigate).not.toHaveBeenCalled();
  expect(mockCreateReply).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('leases a transfer synchronously before navigation commits, preventing double maximize or send', () => {
  const navigate = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" onNavigate={navigate} />);
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('same draft'));
  act(() => {
    const maximize = renderer.root.findAll(
      (node) => node.props.testID === 'compact-reply-maximize',
    )[0].props.onPress;
    maximize();
    maximize();
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
  });
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(mockCreateReply).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});

it('publishes staged media without text and preserves attachment edits made while sending', async () => {
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  const draft = createReplyDraft(() => true);
  draft.store.getState().addMedia([{ id: 'image-private', type: 'image' }]);
  let complete!: () => void;
  mockCreateReply.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ id: 'reply' });
      }),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" draft={draft} />);
  });
  act(() => {
    void renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-submit')[0]
      .props.onPress();
  });
  expect(mockCreateReply).toHaveBeenCalledWith({
    postId: 'p',
    content: { text: '', media: [{ id: 'image-private', type: 'image' }] },
  });
  act(() => draft.store.getState().addMedia([{ id: 'gif-file', type: 'gif' }]));
  await act(async () => {
    complete();
    await Promise.resolve();
  });
  expect(draft.store.getState().mediaIds).toHaveLength(2);
  act(() => renderer.unmount());
});

it('hands off staged image and GIF ids in order without reuploading them', () => {
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  const { consumeReplyComposerHandoff } = jest.requireActual('@/utils/replyComposerHandoff');
  const draft = createReplyDraft();
  const mediaIds = [
    { id: 'image-private', type: 'image', alt: 'A description' },
    { id: 'gif-file', type: 'gif' },
  ];
  draft.store.getState().addMedia(mediaIds);
  const navigate = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <CompactReplyComposer postId="p" draft={draft} onNavigate={navigate} />,
    );
  });
  act(() =>
    renderer.root
      .findAll((node) => node.props.testID === 'compact-reply-maximize')[0]
      .props.onPress(),
  );
  const token = new URL(navigate.mock.calls[0][0], 'https://mention.earth').searchParams.get(
    'replyDraftToken',
  );
  const scope = { viewerId: 'a', epoch: 1, replyToPostId: 'p' };
  const incoming = consumeReplyComposerHandoff(token, scope);
  expect(incoming.mediaIds).toEqual(mediaIds);
  expect(draft.store.getState().mediaIds).toEqual(mediaIds);
  act(() => incoming.acknowledge(scope));
  expect(draft.store.getState().mediaIds).toEqual([]);
  act(() => renderer.unmount());
});

it('rejects overflow without clearing or truncating the accepted draft', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" />);
  });
  const change = (value: string) =>
    act(() => renderer.root.findByType(TextInput).props.onChangeText(value));
  const maximize = () =>
    renderer.root.findAll((node) => node.props.testID === 'compact-reply-maximize')[0].props;
  expect(maximize().tone).toBe('neutral');
  change('a'.repeat(250));
  change('a'.repeat(251));
  expect(maximize().tone).toBe('danger');
  expect(renderer.root.findByType(TextInput).props.value).toBe('a'.repeat(250));
  change('b'.repeat(252));
  expect(maximize().tone).toBe('danger');
  expect(renderer.root.findByType(TextInput).props.value).toBe('a'.repeat(250));
  change('a'.repeat(248) + '😀');
  expect(renderer.root.findByType(TextInput).props.value).toBe('a'.repeat(248) + '😀');
  change('shorter');
  expect(renderer.root.findByType(TextInput).props.value).toBe('shorter');
  act(() => renderer.unmount());
});

it('keeps a legacy long draft intact and allows deletion without inline publication', async () => {
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  const draft = createReplyDraft();
  draft.store.getState().setText('x'.repeat(300));
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" draft={draft} />);
  });
  act(() => renderer.root.findByType(TextInput).props.onChangeText('x'.repeat(301)));
  expect(renderer.root.findByType(TextInput).props.value).toBe('x'.repeat(300));
  const submit = renderer.root.findAll((node) => node.props.testID === 'compact-reply-submit')[0];
  expect(submit.props.disabled).toBe(true);
  await act(async () => {
    await submit.props.onPress();
  });
  expect(mockCreateReply).not.toHaveBeenCalled();
  act(() => renderer.root.findByType(TextInput).props.onChangeText('x'.repeat(299)));
  expect(renderer.root.findByType(TextInput).props.value).toBe('x'.repeat(299));
  act(() => renderer.unmount());
});

it('uses the existing image picker and rejects a late selection from an earlier viewer', () => {
  const { createReplyDraft } = jest.requireActual('../replyDraft');
  const draft = createReplyDraft();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CompactReplyComposer postId="p" draft={draft} />);
  });
  act(() =>
    renderer.root.findAll((node) => node.props.testID === 'compact-reply-image')[0].props.onPress(),
  );
  const select = mockOpenMediaPicker.mock.calls[0][0];
  act(() => select([{ id: 'private-image', type: 'image', alt: 'Original alt' }]));
  expect(draft.store.getState().mediaIds).toEqual([
    { id: 'private-image', type: 'image', alt: 'Original alt' },
  ]);
  mockViewerId = 'b';
  act(() => select([{ id: 'old-viewer-image', type: 'image' }]));
  expect(draft.store.getState().mediaIds).toHaveLength(1);
  act(() => renderer.unmount());
});
