import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { MentionTextInputHandle } from '@/components/MentionTextInput';
import VariantEditor from '../VariantEditor';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; language?: string }) =>
      options?.defaultValue?.replace('{{language}}', options.language ?? '') ?? _key,
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { border: '#333', primary: '#70f', textSecondary: '#777' } }),
}));

jest.mock('@oxy.so/bloom/avatar', () => ({
  Avatar: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@oxy.so/bloom/loading', () => ({
  Loading: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/assets/icons/close-icon', () => ({
  CloseIcon: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/assets/icons/plus-icon', () => ({
  Plus: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/Compose/VideoPreview', () => ({
  VideoPreview: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/Compose/ComposeAltButton', () => ({
  ComposeAltButton: jest.requireActual<typeof import('react-native')>('react-native').View,
}));
jest.mock('@/components/Post/PostArticlePreview', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('react-native')>('react-native').View,
}));

jest.mock('@/components/MentionTextInput', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { TextInput: RNTextInput } = jest.requireActual<typeof import('react-native')>('react-native');
  const MockMentionTextInput = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({
      focus: jest.fn(),
      insertTextAtCursor: jest.fn(),
    }));
    return React.createElement(RNTextInput, props);
  });
  MockMentionTextInput.displayName = 'MockMentionTextInput';
  return {
    __esModule: true,
    default: MockMentionTextInput,
  };
});

const emptyItem = {
  text: '',
  media: { mode: 'inherit' as const, alt: {} },
  article: null,
};

it('keeps the toolbar mounted and wires the active rendition input', () => {
  const onMentionValueChange = jest.fn();
  const onFocus = jest.fn();
  const onTranslate = jest.fn();
  const onPickOwnMedia = jest.fn();
  const onArticlePress = jest.fn();
  const ref = React.createRef<MentionTextInputHandle>();
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  act(() => {
    renderer = TestRenderer.create(
      <VariantEditor
        itemId="main"
        tag="es"
        item={emptyItem}
        primaryText="Hello"
        sharedMedia={[{ id: 'shared-image', type: 'image' }]}
        hasArticle
        userAvatar={undefined}
        userVerified={false}
        isFocused
        isPosting={false}
        isTranslating={false}
        getFileDownloadUrl={(id) => id}
        mentions={[]}
        onMentionValueChange={onMentionValueChange}
        onFocus={onFocus}
        onTranslate={onTranslate}
        onSharedAltPress={jest.fn()}
        onOwnAltPress={jest.fn()}
        onPickOwnMedia={onPickOwnMedia}
        onRemoveOwnMedia={jest.fn()}
        onUseSharedMedia={jest.fn()}
        onArticlePress={onArticlePress}
        onArticleReset={jest.fn()}
        textInputRef={ref}
        toolbar={<Text>Persistent toolbar</Text>}
      />,
    );
  });

  if (!renderer) throw new Error('variant editor did not render');
  expect(renderer.root.findByProps({ children: 'Persistent toolbar' })).toBeTruthy();
  expect(ref.current).not.toBeNull();

  const input = renderer.root.findByType(TextInput);
  act(() => input.props.onValueChange({ text: 'Hola', mentions: [] }));
  act(() => input.props.onFocus());
  act(() => {
    renderer?.root.findAllByType(TouchableOpacity)[0]?.props.onPress();
  });
  act(() => {
    renderer?.root.findAllByType(TouchableOpacity)[1]?.props.onPress();
    renderer?.root.findAllByType(TouchableOpacity)[2]?.props.onPress();
  });

  expect(onMentionValueChange).toHaveBeenCalledWith('main', { text: 'Hola', mentions: [] });
  expect(onFocus).toHaveBeenCalledWith('main');
  expect(onTranslate).toHaveBeenCalledWith('main');
  expect(onPickOwnMedia).toHaveBeenCalledWith('main');
  expect(onArticlePress).toHaveBeenCalledWith('main');
});
