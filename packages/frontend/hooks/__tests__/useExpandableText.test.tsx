import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { useExpandableText } from '../useExpandableText';

function Preview({ text, resetKey }: { text: string; resetKey: string }) {
  const { displayText, toggle } = useExpandableText(text, 5, resetKey);
  return <Text onPress={toggle}>{displayText}</Text>;
}

it('expands and collapses a plain text preview with the same shared expansion state as posts', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Preview text="Hello Mention" resetKey="inline" />);
  });
  if (!renderer) throw new Error('render produced no preview');
  const mounted = renderer;
  expect(mounted.root.findByType(Text).props.children).toBe('Hello…');
  act(() => mounted.root.findByType(Text).props.onPress());
  expect(mounted.root.findByType(Text).props.children).toBe('Hello Mention');
  act(() => mounted.root.findByType(Text).props.onPress());
  expect(mounted.root.findByType(Text).props.children).toBe('Hello…');
  act(() => mounted.unmount());
});

it('collapses recycled content and a changed expansion preference without carrying the old preview', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Preview text="First article" resetKey="inline" />);
  });
  if (!renderer) throw new Error('render produced no preview');
  const mounted = renderer;
  act(() => mounted.root.findByType(Text).props.onPress());
  expect(mounted.root.findByType(Text).props.children).toBe('First article');

  act(() => mounted.update(<Preview text="Other article" resetKey="inline" />));
  expect(mounted.root.findByType(Text).props.children).toBe('Other…');
  act(() => mounted.root.findByType(Text).props.onPress());
  expect(mounted.root.findByType(Text).props.children).toBe('Other article');

  act(() => mounted.update(<Preview text="Other article" resetKey="openPost" />));
  expect(mounted.root.findByType(Text).props.children).toBe('Other…');
  act(() => mounted.update(<Preview text="Third article" resetKey="openPost" />));
  expect(mounted.root.findByType(Text).props.children).toBe('Third…');
  act(() => mounted.unmount());
});
