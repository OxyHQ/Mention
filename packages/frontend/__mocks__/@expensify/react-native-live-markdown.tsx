import React from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import type { MarkdownRange } from '@expensify/react-native-live-markdown';

/**
 * `MarkdownTextInput` as jest sees it.
 *
 * The real component is a NATIVE Fabric view: importing it under jest pulls
 * `react-native-worklets`, which tries to install its native runtime and throws
 * before any test body runs. Mapping it here keeps the suite testing what we
 * actually own — the wiring in `ArticleEditor` and the grammar in
 * `utils/markdownRanges.ts` (exercised directly as a pure function) — rather
 * than a third-party native view we do not control.
 *
 * It stays a REAL `TextInput` so value/onChangeText/placeholder behave exactly
 * as the plain field did, which is what lets the draft-preservation test still
 * mean something. `parser` and `markdownStyle` are passed straight through so a
 * test can assert they were supplied and can run the parser itself.
 */
export type { MarkdownRange, MarkdownType, MarkdownStyle, MarkdownTextInputProps } from '@expensify/react-native-live-markdown';

interface MockMarkdownTextInputProps extends TextInputProps {
  parser: (value: string) => MarkdownRange[];
  markdownStyle?: unknown;
}

export const MarkdownTextInput = React.forwardRef<TextInput, MockMarkdownTextInputProps>(
  function MarkdownTextInput(props, ref) {
    return <TextInput ref={ref} {...props} />;
  },
);

export function parseExpensiMark(): MarkdownRange[] {
  return [];
}

export function getWorkletRuntime(): never {
  throw new Error('getWorkletRuntime is not available under jest');
}
