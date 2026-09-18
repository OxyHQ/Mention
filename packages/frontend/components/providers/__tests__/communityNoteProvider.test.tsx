import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The provider exists so a post row never has to ask the session whether notes
 * can be written — it resolves that once and hands the answer down. So what is
 * worth asserting is exactly that: what a row reads out of the context is what
 * the hook returned, and a tree with no provider reads "nothing can receive a
 * note" rather than crashing or offering a flow that goes nowhere.
 */

const mockHandlers: { current: Record<string, unknown> } = { current: {} };

jest.mock('@/hooks/useCommunityNotes', () => ({
  useCommunityNoteHandlers: () => mockHandlers.current,
}));

import { CommunityNoteProvider } from '../CommunityNoteProvider';
import { useCommunityNoteHandlerContext } from '@/context/CommunityNoteHandlersContext';

let seen: unknown = null;

function Row() {
  seen = useCommunityNoteHandlerContext();
  return null;
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  seen = null;
  mockHandlers.current = {};
});

describe('CommunityNoteProvider', () => {
  it('hands the resolved handlers to everything below it', () => {
    const submitNote = jest.fn();
    const rateNote = jest.fn();
    mockHandlers.current = { submitNote, rateNote };

    act(() => {
      TestRenderer.create(
        <CommunityNoteProvider>
          <Row />
        </CommunityNoteProvider>,
      );
    });

    expect(seen).toEqual({ submitNote, rateNote });
  });

  it('hands down nothing when notes cannot be written here', () => {
    act(() => {
      TestRenderer.create(
        <CommunityNoteProvider>
          <Row />
        </CommunityNoteProvider>,
      );
    });

    expect(seen).toEqual({});
  });

  it('reads as "no handler" in a tree that never mounted it', () => {
    act(() => {
      TestRenderer.create(<Row />);
    });

    expect(seen).toEqual({});
  });
});
