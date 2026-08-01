import React from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import type { MarkdownRange } from '@expensify/react-native-live-markdown';

/**
 * `MarkdownTextInput` as jest sees it, for the DEEP specifier the app imports.
 *
 * The real component is a native Fabric view: importing it under jest pulls
 * `react-native-worklets`, which tries to install its native runtime and throws
 * before any test body runs. It stays a REAL `TextInput` here so
 * value/onChangeText/placeholder behave exactly as the plain field did, and
 * `parser`/`markdownStyle` pass through so a test can assert what was supplied.
 */
export type { MarkdownStyle, MarkdownTextInputProps } from '@expensify/react-native-live-markdown';

interface MockMarkdownTextInputProps extends TextInputProps {
  parser: (value: string) => MarkdownRange[];
  markdownStyle?: unknown;
}

const MarkdownTextInput = React.forwardRef<TextInput, MockMarkdownTextInputProps>(
  function MarkdownTextInput(props, ref) {
    return <TextInput ref={ref} {...props} />;
  },
);

export default MarkdownTextInput;
