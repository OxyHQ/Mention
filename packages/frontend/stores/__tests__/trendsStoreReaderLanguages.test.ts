import { useTrendsStore } from '@/stores/trendsStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn(() => Promise.resolve({ data: { trending: [], summary: '' } })) },
}));

beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
});

it('keeps the reader languages in their order of preference', () => {
  useTrendsStore.getState().setReaderLanguages(['es-ES', 'en-US', 'ca-ES', 'es-ES']);
  expect(useTrendsStore.getState().readerLanguages).toEqual(['es-ES', 'en-US', 'ca-ES']);
});
