import fs from 'fs';
import path from 'path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PostContent } from '@mention/shared-types';

import { usePostLanguage, type PostLanguageState } from '../usePostLanguage';

/**
 * Reading a post in another language.
 *
 * Four contracts:
 *
 * 1. Every rendition the DTO ships carries its body. Switching between them is a
 *    `setState` — a request there would be a round trip for a string already in
 *    memory.
 * 2. Any OTHER language is a translate call. The client does not know, and must
 *    not try to guess, whether the server will answer it from a cache or a model.
 * 3. NOTHING TRANSLATES ON ITS OWN. Mounting, rendering, recycling, render-ahead
 *    and viewability make zero translate requests. The server's hydration already
 *    chose the body on screen; a missing language is only ever manufactured
 *    after an explicit reader action (the icon or the picker).
 * 4. Nothing here asks who the reader is. Translation is not premium — the hook
 *    takes no viewer, no entitlement, and no upsell route.
 * 5. `canTranslate` decides the icon's presence, so the icon is absent exactly
 *    where translating would do nothing — and stays present once translated, or
 *    there would be no way back.
 */

const mockApiPost = jest.fn();
jest.mock('@/utils/api', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
}));

const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

/** The reader's app display language. Flipped per test. */
let mockReaderLanguage = 'en-US';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: mockReaderLanguage },
  }),
}));

/**
 * The reader's OWN declared account languages, most-preferred first — separate
 * from the app display language above, exactly as a real bilingual reader's
 * account locales differ from whatever locale their UI chrome happens to be
 * in. Empty by default so existing single-language tests keep testing exactly
 * one language, the app display one.
 *
 * Combined into the ONE `readerLanguages` list `trendsStore` holds — the hook
 * reads that store directly (`AccountSwitchReset` is what actually computes
 * and pushes this list in the real app), so the mock reproduces its shape
 * rather than the hook's own retired internal derivation.
 */
let mockAccountLanguages: string[] = [];
jest.mock('@/stores/trendsStore', () => ({
  useTrendsStore: (selector: (state: { readerLanguages: string[] }) => unknown) =>
    selector({ readerLanguages: [...mockAccountLanguages, mockReaderLanguage].filter(Boolean) }),
}));

/** The author wrote this post in Spanish (primary) and in English. */
const bilingual: PostContent = {
  text: 'Hola mundo',
  textLang: 'es-ES',
  variants: [
    { tag: 'es-ES', source: 'author', text: 'Hola mundo' },
    { tag: 'en', source: 'author', text: 'Hello world' },
  ],
};

/**
 * English, shipped with the machine translation for THIS reader's language. The
 * DTO carries the body, so reading it is free — the reader never learns whether
 * the server had it cached.
 */
const englishWithMachineItalian: PostContent = {
  text: 'Hello world',
  textLang: 'en',
  variants: [
    { tag: 'en', source: 'author', text: 'Hello world' },
    { tag: 'it', source: 'machine', text: 'Ciao mondo' },
  ],
};

/** English, and nothing else: any other language has to be asked for. */
const englishOnly: PostContent = {
  text: 'Hello world',
  textLang: 'en',
  variants: [{ tag: 'en', source: 'author', text: 'Hello world' }],
};

let state: PostLanguageState;

const Probe: React.FC<{ content: PostContent; postId?: string; postLanguage?: string }> = ({
  content,
  postId,
  postLanguage,
}) => {
  state = usePostLanguage(content, postId, postLanguage);
  return null;
};

async function render(content: PostContent, postId = 'post-1', postLanguage?: string) {
  await act(async () => {
    TestRenderer.create(<Probe content={content} postId={postId} postLanguage={postLanguage} />);
  });
}

beforeEach(() => {
  mockApiPost.mockReset();
  mockToast.mockReset();
  mockReaderLanguage = 'en-US';
  mockAccountLanguages = [];
});

/** Let any queued microtask or promise continuation run before asserting. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * WHAT A RECYCLED ROW COSTS, AND WHAT IT MUST NOT SHOW.
 *
 * FlashList hands one mounted `PostItem` a different post as the reader scrolls,
 * so this hook sees `postId` change under it. Two things have to be true at
 * once, and the pair is the point: the reader's translation of the PREVIOUS post
 * must be gone on the FIRST render of the new one (an Effect would paint a frame
 * of the wrong body), and getting there must not cost a second render of the row
 * (React's "adjust state during render" throws the first one away — measured on
 * a Pixel 10 Pro, that was ~31 extra `PostItem` renders in a single scroll, a
 * whole row rebuilt per recycle).
 *
 * Either assertion alone is satisfiable by the thing the other one forbids.
 */
describe('a row recycled onto another post', () => {
  it('drops the previous post’s translation on the first render of the new one', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe content={bilingual} postId="post-1" />);
    });

    await act(async () => {
      state.selectLanguage('en');
    });
    expect(state.activeTag).toBe('en');
    expect(state.displayText).toBe('Hello world');

    // The same component instance, a different post — a recycle.
    await act(async () => {
      renderer.update(<Probe content={bilingual} postId="post-2" />);
    });

    expect(state.activeTag).toBe('es-ES');
    expect(state.displayText).toBeNull();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('renders once for the recycle, not twice', async () => {
    const renders = jest.fn();
    const CountingProbe: React.FC<{ content: PostContent; postId?: string }> = ({
      content,
      postId,
    }) => {
      state = usePostLanguage(content, postId);
      renders();
      return null;
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<CountingProbe content={bilingual} postId="post-1" />);
    });

    await act(async () => {
      state.selectLanguage('en');
    });
    renders.mockClear();

    await act(async () => {
      renderer.update(<CountingProbe content={bilingual} postId="post-2" />);
    });

    // One render for the new post. A setState during render would make React
    // discard this one and run the whole component again.
    expect(renders).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('never shows the previous post’s MACHINE translation, even one that lands after the recycle', async () => {
    mockReaderLanguage = 'it-IT';
    let resolveTranslate!: (value: unknown) => void;
    mockApiPost.mockReturnValue(new Promise((resolve) => { resolveTranslate = resolve; }));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe content={englishOnly} postId="post-1" />);
    });
    await act(async () => {
      state.toggleReaderTranslation();
    });
    expect(state.isTranslating).toBe(true);

    // Recycled onto another post while post-1's translation is still in flight.
    await act(async () => {
      renderer.update(<Probe content={englishOnly} postId="post-2" />);
    });
    await act(async () => {
      resolveTranslate({ data: { translatedText: 'Ciao mondo', tag: 'it-IT' } });
    });
    await flush();

    expect(state.displayText).toBeNull();
    expect(state.isTranslated).toBe(false);
    expect(state.isTranslating).toBe(false);
    expect(state.activeTag).toBe('en');
    // The only request is the one the reader asked for, on post-1.
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/posts/post-1/translate', { targetLanguage: 'it-IT' });

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('the renditions a post ships with', () => {
  it('shows the body the server resolved, with no override of its own', async () => {
    await render(bilingual);
    expect(state.activeTag).toBe('es-ES');
    expect(state.displayText).toBeNull();
  });

  it('offers the author renditions and the reader’s own machine one', async () => {
    await render(englishWithMachineItalian);
    expect(state.options).toEqual([
      { tag: 'en', source: 'author', text: 'Hello world' },
      { tag: 'it', source: 'machine', text: 'Ciao mondo' },
    ]);
  });

  it('offers a single-rendition post nothing to switch to', async () => {
    await render(englishOnly);
    expect(state.options).toHaveLength(1);
  });
});

describe('switching between the shipped renditions', () => {
  it('swaps to another author rendition instantly, and never touches the network', async () => {
    await render(bilingual);

    await act(async () => {
      state.selectLanguage('en');
    });

    expect(state.displayText).toBe('Hello world');
    expect(state.activeTag).toBe('en');
    expect(state.isTranslated).toBe(false);
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('swaps to the shipped MACHINE rendition without a request either — its body came along', async () => {
    await render(englishWithMachineItalian);

    await act(async () => {
      state.selectLanguage('it');
    });

    expect(state.displayText).toBe('Ciao mondo');
    expect(state.isTranslated).toBe(true);
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('returns to the server-resolved body without a request', async () => {
    await render(bilingual);

    await act(async () => {
      state.selectLanguage('en');
    });
    await act(async () => {
      state.selectLanguage('es-ES');
    });

    expect(state.displayText).toBeNull();
    expect(mockApiPost).not.toHaveBeenCalled();
  });
});

describe('asking for a language the post does not carry', () => {
  it('translates on demand — the client never guesses whether the server has it cached', async () => {
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hallo Welt', tag: 'de' } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(mockApiPost).toHaveBeenCalledWith('/posts/post-1/translate', { targetLanguage: 'de' });
    expect(state.displayText).toBe('Hallo Welt');
    expect(state.isTranslated).toBe(true);
  });

  it('serves a second look at that language from memory', async () => {
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hallo Welt', tag: 'de' } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });
    await act(async () => {
      state.selectLanguage('en');
    });
    await act(async () => {
      state.selectLanguage('de');
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(state.displayText).toBe('Hallo Welt');
  });

  it('follows the tag the SERVER canonicalized the variant to', async () => {
    // Asked for `de`, stored as `de-DE`: keying the body by what we asked for
    // would strand it beside the variant the next hydration ships.
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hallo Welt', tag: 'de-DE' } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(state.activeTag).toBe('de-DE');
    expect(state.displayText).toBe('Hallo Welt');
  });

  it('keys the body by the REQUESTED tag when the server names none', async () => {
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hallo Welt' } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(state.activeTag).toBe('de');
    expect(state.displayText).toBe('Hallo Welt');
  });

  it('never asks the server for a post with no id', async () => {
    await act(async () => {
      TestRenderer.create(<Probe content={englishOnly} />);
    });

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('falls back to the original body and says so when the translation fails', async () => {
    mockApiPost.mockRejectedValue({ response: { status: 429 } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(state.displayText).toBeNull();
    expect(state.activeTag).toBe('en');
    expect(mockToast).toHaveBeenCalledWith('translation.rateLimited', { type: 'error' });
  });

  it('falls back and says so when the server answers with no usable text', async () => {
    // A 200 with an empty/absent `translatedText` — the request succeeded but
    // produced nothing to show, which must be treated the same as a failure
    // rather than silently displaying an empty body.
    mockApiPost.mockResolvedValue({ data: { translatedText: '' } });
    await render(englishOnly);

    await act(async () => {
      state.selectLanguage('de');
    });

    expect(state.displayText).toBeNull();
    expect(state.activeTag).toBe('en');
    expect(mockToast).toHaveBeenCalledWith('translation.failed', { type: 'error' });
  });
});

describe('the translate button', () => {
  it('translates for ANY reader — there is no premium gate on the reading path', async () => {
    // No viewer, no entitlement, no upsell: the hook cannot even see who is
    // reading. Translation used to route free users to /subscribe.
    mockReaderLanguage = 'it-IT';
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Ciao mondo', tag: 'it-IT' } });
    await render(englishOnly);

    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(state.displayText).toBe('Ciao mondo');
    expect(state.isTranslated).toBe(true);
  });

  it('undoes the translation on a second press', async () => {
    mockReaderLanguage = 'it-IT';
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Ciao mondo', tag: 'it-IT' } });
    await render(englishOnly);

    await act(async () => {
      state.toggleReaderTranslation();
    });
    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(state.displayText).toBeNull();
    expect(state.isTranslated).toBe(false);
  });

  it('does nothing when the reader has no language at all to translate into', async () => {
    // No account languages and no app display language resolved — nothing
    // for the picker's "translate into my language" action to target. Must
    // not crash and must not guess a language to call the server with.
    mockReaderLanguage = '';
    mockAccountLanguages = [];
    await render(englishOnly);

    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(mockApiPost).not.toHaveBeenCalled();
    expect(state.displayText).toBeNull();
  });

  it('reaches for the author’s own rendition before asking a machine', async () => {
    mockReaderLanguage = 'en-GB';
    await render(bilingual);

    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(state.displayText).toBe('Hello world');
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('reads the machine rendition the post already shipped rather than asking for it again', async () => {
    mockReaderLanguage = 'it-IT';
    await render(englishWithMachineItalian);

    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(state.displayText).toBe('Ciao mondo');
    expect(mockApiPost).not.toHaveBeenCalled();
  });
});

describe('whether the action bar shows a translate icon at all', () => {
  it('offers nothing on a post already written in the reader’s language', async () => {
    mockReaderLanguage = 'es-MX';
    await render(bilingual);
    expect(state.canTranslate).toBe(false);
  });

  it('offers nothing when the AUTHOR wrote a rendition in the reader’s language', async () => {
    // Served in English, but the author's own Spanish is one tap away through
    // the picker — a machine has nothing to add.
    mockReaderLanguage = 'es-MX';
    await render({ ...bilingual, text: 'Hello world', textLang: 'en-US' });
    expect(state.canTranslate).toBe(false);
  });

  it('offers an icon on a foreign post', async () => {
    mockReaderLanguage = 'es-ES';
    await render(englishOnly);
    expect(state.canTranslate).toBe(true);
  });

  it('KEEPS the icon once the reader has translated — it is the only way back', async () => {
    mockReaderLanguage = 'it-IT';
    await render(englishWithMachineItalian);

    await act(async () => {
      state.toggleReaderTranslation();
    });

    expect(state.isTranslated).toBe(true);
    expect(state.canTranslate).toBe(true);
  });

  it('offers nothing on a post with no body to translate', async () => {
    mockReaderLanguage = 'es-ES';
    await render({ text: '   ', textLang: 'en' });
    expect(state.canTranslate).toBe(false);
  });

  it('offers nothing when the post is served in ANY of the reader’s several account languages, not just the app’s display language', async () => {
    // The app chrome is in English, but the reader's account also lists
    // Spanish, and this post is served in Spanish — they already understand
    // it, so translating would do nothing.
    mockReaderLanguage = 'en-US';
    mockAccountLanguages = ['en', 'es'];
    await render({ text: 'Hola mundo', textLang: 'es-ES' });
    expect(state.canTranslate).toBe(false);
  });
});

/**
 * THERE IS NO AUTOMATIC TRANSLATION.
 *
 * Hydration (`PostHydrationService`) resolves `content.text` to the best
 * rendition the server already HAS for this reader; the client renders it. A
 * missing language is manufactured only by `POST /posts/:id/translate`, and only
 * after the reader taps Translate or picks a language.
 */
describe('no automatic translation', () => {
  it('makes zero translate requests when a foreign post mounts', async () => {
    mockReaderLanguage = 'es-ES';
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hola mundo', tag: 'es-ES' } });

    await render(englishOnly);
    await flush();

    expect(state.canTranslate).toBe(true);
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(state.displayText).toBeNull();
    expect(state.activeTag).toBe('en');
  });

  it('makes zero requests across re-renders, render-ahead, recycling and viewability changes', async () => {
    mockReaderLanguage = 'ja-JP';
    mockAccountLanguages = ['ja', 'ko'];
    mockApiPost.mockResolvedValue({ data: { translatedText: 'こんにちは世界', tag: 'ja-JP' } });

    // A row that also receives the props a list feeds it as it scrolls — the
    // hook has no visibility input, and none of this may reach the network.
    const Row: React.FC<{ content: PostContent; postId: string; visible: boolean }> = ({
      content,
      postId,
    }) => {
      state = usePostLanguage(content, postId);
      return null;
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      // Rendered ahead, off screen.
      renderer = TestRenderer.create(<Row content={englishOnly} postId="post-1" visible={false} />);
    });
    await flush();
    await act(async () => {
      renderer.update(<Row content={englishOnly} postId="post-1" visible />);
    });
    await flush();
    await act(async () => {
      renderer.update(<Row content={englishOnly} postId="post-1" visible={false} />);
    });
    for (const id of ['post-2', 'post-3', 'post-4']) {
      // Recycled onto another foreign post, then scrolled into view.
      await act(async () => {
        renderer.update(<Row content={{ ...englishOnly }} postId={id} visible={false} />);
      });
      await act(async () => {
        renderer.update(<Row content={{ ...englishOnly }} postId={id} visible />);
      });
      await flush();
    }

    expect(state.canTranslate).toBe(true);
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(state.displayText).toBeNull();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('renders a hydration-selected machine translation directly, with no client request', async () => {
    // The server already served this reader the cached Italian machine
    // rendition as `content.text`. The client renders it as-is: no override,
    // no request, nothing to "auto" do.
    mockReaderLanguage = 'it-IT';
    const servedInItalian: PostContent = {
      text: 'Ciao mondo',
      textLang: 'it',
      variants: [
        { tag: 'en', source: 'author', text: 'Hello world' },
        { tag: 'it', source: 'machine', text: 'Ciao mondo' },
      ],
    };

    await render(servedInItalian);
    await flush();

    expect(state.activeTag).toBe('it');
    expect(state.displayText).toBeNull();
    expect(state.canTranslate).toBe(false);
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('calls the translate endpoint exactly once, and only after the reader taps Translate', async () => {
    mockReaderLanguage = 'es-MX';
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hola mundo', tag: 'es-MX' } });

    await render(englishOnly);
    await flush();
    expect(mockApiPost).not.toHaveBeenCalled();

    await act(async () => {
      state.toggleReaderTranslation();
    });
    await flush();

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/posts/post-1/translate', { targetLanguage: 'es-MX' });
    expect(state.displayText).toBe('Hola mundo');
    expect(state.isTranslated).toBe(true);
  });

  it('leaves no auto-translate store, preference or strings behind', () => {
    const root = path.resolve(__dirname, '../..');
    expect(fs.existsSync(path.join(root, 'stores/autoTranslateStore.ts'))).toBe(false);

    const hookSource = fs.readFileSync(path.join(root, 'hooks/usePostLanguage.ts'), 'utf8');
    expect(hookSource).not.toMatch(/autoTranslate|queueMicrotask/i);

    const settingsSource = fs.readFileSync(
      path.join(root, 'components/settings/pages/language.tsx'),
      'utf8',
    );
    expect(settingsSource).not.toMatch(/autoTranslate/i);

    for (const file of fs.readdirSync(path.join(root, 'locales'))) {
      if (!file.endsWith('.json')) continue;
      const locale = fs.readFileSync(path.join(root, 'locales', file), 'utf8');
      expect(locale).not.toContain('settings.language.autoTranslate');
    }

    // The retired preference's persisted value is cleared at startup.
    const initializer = fs.readFileSync(path.join(root, 'lib/appInitializer.ts'), 'utf8');
    expect(initializer).toMatch(/OBSOLETE_STORAGE_KEYS = \['auto-translate-preference'\]/);
  });
});
