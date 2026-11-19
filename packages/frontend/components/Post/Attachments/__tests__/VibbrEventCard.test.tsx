import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { VibbrEventCard } from '../VibbrEventCard';

const mockLoad = jest.fn();
jest.mock('@/lib/references/vibbrEvents', () => {
  const { VisibleReferenceStore } = jest.requireActual('@/lib/references/VisibleReferenceStore');
  return {
    vibbrEvents: new VisibleReferenceStore(
      (ids: readonly string[], options: { signal: AbortSignal }) => mockLoad(ids, options),
    ),
  };
});
jest.mock('@oxy.so/bloom/video-playback', () => ({ useViewableVisible: () => true }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
    i18n: { language: 'en-US' },
  }),
}));

const ID = `evt_${'a'.repeat(24)}`;
const card = {
  id: ID,
  title: 'Fado Night',
  startsAt: '2027-01-10T20:00:00.000Z',
  endsAt: null,
  timeZone: 'Europe/Lisbon',
  status: 'published',
  coverUrl: null,
  venueName: 'Clube de Fado',
  city: 'Lisboa',
  organizerName: 'Clube',
  priceFrom: { amount: '1500', currency: 'EUR' },
  free: false,
  soldOut: false,
  url: `https://vibbr.co/e/${ID}`,
};

let renderer: TestRenderer.ReactTestRenderer;
const screen = () => JSON.stringify(renderer.toJSON());
beforeEach(() => {
  jest.useFakeTimers();
  mockLoad.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});

it('reserves the same box while loading, then shows the event, and degrades when it is gone', async () => {
  mockLoad.mockResolvedValue({ items: [card], unavailableIds: [] });
  act(() => {
    renderer = TestRenderer.create(
      <>
        <Text>Feed ready</Text>
        <VibbrEventCard eventId={ID} />
      </>,
    );
  });
  expect(screen()).toContain('Feed ready');
  expect(screen()).toContain('Loading Vibbr event');
  expect(renderer.root.findByProps({ testID: 'vibbr-event-card' }).props.style).toEqual({
    width: '100%',
    height: 200,
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(100);
  });
  expect(screen()).toContain('Fado Night');
  expect(screen()).toContain('Clube de Fado');
});

it('says so when the event is no longer available', async () => {
  mockLoad.mockResolvedValue({ items: [], unavailableIds: [ID] });
  act(() => {
    renderer = TestRenderer.create(<VibbrEventCard eventId={ID} />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(100);
  });
  expect(screen()).toContain('no longer available');
});
