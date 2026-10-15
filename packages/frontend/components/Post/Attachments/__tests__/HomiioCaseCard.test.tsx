import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { HomiioCaseCard } from '../HomiioCaseCard';
import { homiioCases } from '@/lib/references/homiioCases';

const mockLoad = jest.fn();
let mockVisible = true;
jest.mock('@/lib/references/homiioCases', () => {
  const { VisibleReferenceStore } = jest.requireActual('@/lib/references/VisibleReferenceStore');
  return {
    homiioCases: new VisibleReferenceStore(
      (ids: readonly string[], options: { signal: AbortSignal }) => mockLoad(ids, options),
    ),
  };
});
jest.mock('@/hooks/useReferenceVisibility', () => ({
  useReferenceVisibility: () => ({ nativeID: 'test-card', visible: mockVisible }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
  }),
}));

const publicCase = {
  id: 'case-1',
  title: 'Save this home',
  area: { label: 'Central district', precision: 'area' },
  scheduledAt: '2026-10-20T10:00:00Z',
  status: 'upcoming',
  url: 'https://homiio.com/evictions/case-1',
};
let renderer: TestRenderer.ReactTestRenderer;
const screen = () => JSON.stringify(renderer.toJSON());
const box = () => renderer.root.findByProps({ testID: 'homiio-case-card' }).props.style;
beforeEach(() => {
  jest.useFakeTimers();
  mockLoad.mockReset();
  mockVisible = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});

it('keeps the surrounding feed usable during a hung provider, and reserves identical card height', async () => {
  mockLoad.mockReturnValue(new Promise(() => {}));
  act(() => {
    renderer = TestRenderer.create(
      <>
        <Text>Feed ready</Text>
        <HomiioCaseCard caseId="case-1" />
      </>,
    );
  });
  expect(screen()).toContain('Feed ready');
  expect(screen()).toContain('Loading Homiio case');
  expect(box()).toEqual({ width: '100%', height: 200 });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8_016);
  });
  expect(screen()).toContain('unavailable');
  expect(box()).toEqual({ width: '100%', height: 200 });
});

it('shows only current public fields and clears them on withdrawal', async () => {
  mockLoad
    .mockResolvedValueOnce({ items: [publicCase], unavailableIds: [] })
    .mockResolvedValueOnce({ items: [], unavailableIds: ['case-1'] });
  act(() => {
    renderer = TestRenderer.create(<HomiioCaseCard caseId="case-1" />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(screen()).toContain('Save this home');
  expect(screen()).toContain('Central district');
  expect(screen()).toContain('upcoming');
  expect(box()).toEqual({ width: '100%', height: 200 });
  act(() => {
    homiioCases.refresh();
  });
  expect(screen()).not.toContain('Save this home');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(screen()).toContain('unavailable');
  expect(screen()).not.toContain('Central district');
});

it('does not resolve a hidden card until it becomes visible', async () => {
  mockVisible = false;
  mockLoad.mockResolvedValue({ items: [publicCase], unavailableIds: [] });
  act(() => {
    renderer = TestRenderer.create(<HomiioCaseCard caseId="case-1" />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(mockLoad).not.toHaveBeenCalled();
  mockVisible = true;
  act(() => {
    renderer.update(<HomiioCaseCard caseId="case-1" />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(mockLoad).toHaveBeenCalledTimes(1);
});
