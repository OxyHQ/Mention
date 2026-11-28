import TestRenderer, { act } from 'react-test-renderer';
import { MeterRing } from '@oxy.so/bloom/stat-bar';
import { MAX_POST_TEXT_LENGTH } from '@mention/shared-types/post';
import { ComposeCharacterCount } from '../ComposeCharacterCount';
import { COMPACT_REPLY_TEXT_LIMIT } from '@/components/Post/compactReplyText';

jest.mock('@oxy.so/bloom/stat-bar', () => ({ MeterRing: () => null }));

it('keeps the empty ring and distinct compact/full publication limits', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ComposeCharacterCount count={0} />);
  });
  expect(renderer.root.findByType(MeterRing).props).toMatchObject({ value: 0, max: 25000 });
  expect(MAX_POST_TEXT_LENGTH).toBe(25000);
  act(() => {
    renderer.update(<ComposeCharacterCount count={252} />);
  });
  expect(renderer.root.findByType(MeterRing).props).toMatchObject({ value: 252, max: 25000 });
  act(() => {
    renderer.update(<ComposeCharacterCount count={250} max={COMPACT_REPLY_TEXT_LIMIT} />);
  });
  expect(renderer.root.findByType(MeterRing).props).toMatchObject({ value: 250, max: 250 });
  act(() => renderer.unmount());
});
