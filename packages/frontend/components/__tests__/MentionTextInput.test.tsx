import React, { useState } from 'react';
import { TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import MentionTextInput from '../MentionTextInput';
import {
  reconcileMentionTextValue,
  type MentionTextValue,
} from '@/utils/mentions';

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: { textTertiary: '#999' },
  }),
}));

jest.mock('../MentionPicker', () => ({
  __esModule: true,
  default: () => null,
}));

const alice = {
  userId: 'alice-id',
  username: 'alice',
  displayName: 'Alice',
};

let latestState: MentionTextValue;

function ControlledInput() {
  const [state, setState] = useState<MentionTextValue>({
    text: 'Hello [mention:alice-id]',
    mentions: [alice],
  });
  latestState = state;
  return (
    <MentionTextInput
      value={state.text}
      mentions={state.mentions}
      onValueChange={(next) => setState(reconcileMentionTextValue(next))}
    />
  );
}

describe('MentionTextInput controlled mention state', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

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
  });
});
