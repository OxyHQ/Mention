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
 * 3. Auto-translate must never machine-translate a post the author WROTE in the
 *    reader's language. Same language, different region (`es-MX` reader, `es-ES`
 *    post) is the same language.
 * 4. Nothing here asks who the reader is. Translation is not premium — the hook
 *    takes no viewer, no entitlement, and no upsell route.
 */

const mockApiPost = jest.fn();
jest.mock('@/utils/api', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
}));

const mockToast = jest.fn();
jest.mock('@oxyhq/bloom/toast', () => ({ show: (...args: unknown[]) => mockToast(...args) }));

/** The reader's app language. Flipped per test. */
let mockReaderLanguage = 'en-US';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: mockReaderLanguage },
  }),
}));

/** The auto-translate preference. Flipped per test. */
let mockAutoTranslateEnabled = false;
jest.mock('@/stores/autoTranslateStore', () => ({
  useAutoTranslateStore: <T,>(selector: (state: { enabled: boolean }) => T): T =>
    selector({ enabled: mockAutoTranslateEnabled }),
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
  mockAutoTranslateEnabled = false;
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

describe('auto-translate', () => {
  it('does NOT machine-translate a post the author wrote in the reader’s language', async () => {
    // Served in English (a cold request without Accept-Language), but the author
    // also wrote it in Spanish, and the reader reads Spanish.
    mockAutoTranslateEnabled = true;
    mockReaderLanguage = 'es-MX';

    await render({ ...bilingual, text: 'Hello world', textLang: 'en-US' });

    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('does NOT fire when the body on screen is already the reader’s language', async () => {
    mockAutoTranslateEnabled = true;
    mockReaderLanguage = 'es-MX';

    await render(bilingual);

    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('translates a foreign post the author never wrote in the reader’s language', async () => {
    mockAutoTranslateEnabled = true;
    mockReaderLanguage = 'es-ES';
    mockApiPost.mockResolvedValue({ data: { translatedText: 'Hola mundo', tag: 'es-ES' } });

    await render(englishOnly);

    expect(mockApiPost).toHaveBeenCalledWith('/posts/post-1/translate', {
      targetLanguage: 'es-ES',
    });
    expect(state.displayText).toBe('Hola mundo');
  });

  it('shows a machine rendition the post already shipped without asking for it again', async () => {
    mockAutoTranslateEnabled = true;
    mockReaderLanguage = 'it-IT';

    await render(englishWithMachineItalian);

    expect(state.displayText).toBe('Ciao mondo');
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('stays off when the reader has not asked for it', async () => {
    mockReaderLanguage = 'es-ES';

    await render(englishOnly);

    expect(mockApiPost).not.toHaveBeenCalled();
  });
});
