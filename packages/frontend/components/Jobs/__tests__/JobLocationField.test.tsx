import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

type Props = Record<string, unknown> & { children?: React.ReactNode };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
    i18n: { language: 'en' },
  }),
}));

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' }, canUsePrivateApi: true }),
}));

const mockUseQuery = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

jest.mock('@/services/jobsService', () => ({
  jobsService: { searchPlaces: jest.fn() },
}));

jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ open, children }: Props) => (open ? children : null),
}));
jest.mock('@oxy.so/bloom/item', () => ({
  Item: (props: Props) => {
    const { View } = jest.requireActual('react-native');
    return <View testID="item" {...props} />;
  },
}));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/search', () => ({
  Search: (props: Props) => {
    const { View } = jest.requireActual('react-native');
    return <View testID="search" {...props} />;
  },
}));
jest.mock('@oxy.so/bloom/segmented-control', () => ({
  SegmentedControl: (props: Props) => {
    const { View } = jest.requireActual('react-native');
    return <View testID="segmented" {...props} />;
  },
  SegmentedControlItem: ({ children }: Props) => children,
  SegmentedControlItemText: ({ children }: Props) => children,
}));

import JobLocationField, {
  EMPTY_JOB_LOCATION,
  isJobLocationIncomplete,
  jobLocationDraftFrom,
  jobLocationInputFrom,
  type JobLocationDraft,
} from '../JobLocationField';
import CodePickerDialog from '../CodePickerDialog';

const BARCELONA = { id: '3128760', kind: 'city' as const, name: 'Barcelona', countryCode: 'ES' as const, region: 'Catalonia' };

const mounted: ReactTestRenderer[] = [];

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((renderer) => renderer.unmount());
  });
  jest.useRealTimers();
});

function items(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props.testID === 'item' && typeof node.props.onPress === 'function',
  );
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseQuery.mockReturnValue({ data: undefined, isFetching: false, isError: false });
});

describe('job location drafts', () => {
  it('round-trips a stored place, a stored country and no location', () => {
    const place = jobLocationDraftFrom({ placeId: '3128760', countryCode: 'ES', region: 'Catalonia', city: 'Barcelona' });
    expect(place).toEqual({ kind: 'place', place: BARCELONA });
    expect(jobLocationInputFrom(place)).toEqual({ placeId: '3128760' });

    const region = jobLocationDraftFrom({ placeId: '3336901', countryCode: 'ES', region: 'Catalonia' });
    expect(region).toEqual({
      kind: 'place',
      place: { id: '3336901', kind: 'region', name: 'Catalonia', countryCode: 'ES', region: undefined },
    });

    const country = jobLocationDraftFrom({ countryCode: 'DE' });
    expect(jobLocationInputFrom(country)).toEqual({ countryCode: 'DE' });

    expect(jobLocationDraftFrom(undefined)).toBe(EMPTY_JOB_LOCATION);
    expect(jobLocationInputFrom(EMPTY_JOB_LOCATION)).toBeUndefined();
  });

  it('treats a chosen kind with nothing picked as incomplete, never as free text', () => {
    expect(isJobLocationIncomplete({ kind: 'place', place: null })).toBe(true);
    expect(isJobLocationIncomplete({ kind: 'country', countryCode: null })).toBe(true);
    expect(isJobLocationIncomplete({ kind: 'place', place: BARCELONA })).toBe(false);
    expect(isJobLocationIncomplete(EMPTY_JOB_LOCATION)).toBe(false);
  });
});

describe('JobLocationField', () => {
  it('switches kind through the segmented control, starting each kind empty', () => {
    const onChange = jest.fn();
    const renderer = render(<JobLocationField value={EMPTY_JOB_LOCATION} onChange={onChange} />);
    const segmented = renderer.root.find((node) => node.props.testID === 'segmented');
    act(() => segmented.props.onChange('place'));
    act(() => segmented.props.onChange('country'));
    act(() => segmented.props.onChange('none'));
    expect(onChange.mock.calls.map(([draft]) => draft)).toEqual([
      { kind: 'place', place: null },
      { kind: 'country', countryCode: null },
      // 'none' while already 'none' is not a change.
    ]);
  });

  it('picks a place from the autocomplete results', () => {
    mockUseQuery.mockReturnValue({ data: { places: [BARCELONA] }, isFetching: false, isError: false });
    const onChange = jest.fn();
    const value: JobLocationDraft = { kind: 'place', place: null };
    jest.useFakeTimers();
    const renderer = render(<JobLocationField value={value} onChange={onChange} />);

    // Open the place dialog, then type enough to enable the search.
    act(() => items(renderer)[0].props.onPress());
    const search = renderer.root.find((node) => node.props.testID === 'search');
    act(() => search.props.onChangeText('barc'));
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(mockUseQuery).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));

    const result = items(renderer).find((node) => node.props.title === 'Barcelona');
    expect(result?.props.subtitle).toContain('Catalonia');
    act(() => result!.props.onPress());
    expect(onChange).toHaveBeenCalledWith({ kind: 'place', place: BARCELONA });
  });

  it('picks a country from the closed list', () => {
    const onChange = jest.fn();
    const renderer = render(<JobLocationField value={{ kind: 'country', countryCode: null }} onChange={onChange} />);
    act(() => items(renderer)[0].props.onPress());
    const spain = items(renderer).find((node) => node.props.title === 'Spain' || node.props.title === 'ES');
    act(() => spain!.props.onPress());
    expect(onChange).toHaveBeenCalledWith({ kind: 'country', countryCode: 'ES' });
  });
});

describe('CodePickerDialog', () => {
  it('filters by code prefix or accent-insensitive name, and says when nothing matches', () => {
    const onSelect = jest.fn();
    const renderer = render(
      <CodePickerDialog
        open
        title="Currency"
        searchLabel="Search"
        options={[
          { code: 'EUR', name: 'Euro' },
          { code: 'ISK', name: 'Íslensk króna' },
          { code: 'XCG' },
        ]}
        selected="EUR"
        onSelect={onSelect}
        onClose={jest.fn()}
      />,
    );
    const search = () => renderer.root.find((node) => node.props.testID === 'search');

    act(() => search().props.onChangeText('islensk'));
    expect(items(renderer).map((node) => node.props.title)).toEqual(['Íslensk króna']);

    act(() => search().props.onChangeText('xc'));
    expect(items(renderer).map((node) => node.props.title)).toEqual(['XCG']);

    act(() => search().props.onChangeText('zzz'));
    expect(items(renderer)).toHaveLength(0);

    act(() => search().props.onChangeText(''));
    act(() => items(renderer)[0].props.onPress());
    expect(onSelect).toHaveBeenCalledWith('EUR');
  });
});
