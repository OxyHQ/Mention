import TestRenderer, { act } from 'react-test-renderer';
import type { CardFormProps } from '@oxy.so/bloom/card-form';
import { LocalCheckoutCardEntry } from '../LocalCheckoutCardEntry';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/** Under Bloom's theme provider: the language paints its text and glyphs from the theme, as the app's provider supplies it. */
function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}
let mockForm: CardFormProps;
let mockButton: { disabled: boolean; onPress(): void };
let mockCheckbox: { checked: boolean; onCheckedChange(value: boolean): void };
jest.mock('@oxy.so/bloom/card-form', () => ({
  // Exercise Bloom's real pure validators without loading its native overlay/worklet graph.
  ...jest.requireActual(
    require.resolve('@oxy.so/bloom/card-form').replace(/index(?:\.web)?\.(js|ts)$/, 'shared.$1'),
  ),
  ...jest.requireActual(
    require.resolve('@oxy.so/bloom/card-form').replace(/index(?:\.web)?\.(js|ts)$/, 'constants.$1'),
  ),
  CardForm: (props: CardFormProps) => {
    mockForm = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: (props: typeof mockButton) => {
    mockButton = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/checkbox', () => ({
  Checkbox: (props: typeof mockCheckbox) => {
    mockCheckbox = props;
    return null;
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let renderer: TestRenderer.ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));
const input = {
  number: '4242 4242 4242 4242',
  expiry: '12/30',
  securityCode: '123',
  name: '',
  country: 'US',
  postcode: '19802',
};
it('requires well-formed fields and passes only masked metadata, clearing inputs before completion', () => {
  const onCard = jest.fn(),
    onDone = jest.fn();
  act(() => {
    renderer = TestRenderer.create(
      themed(<LocalCheckoutCardEntry card={null} onCard={onCard} onDone={onDone} />),
    );
  });
  expect(mockButton.disabled).toBe(true);
  act(() => mockButton.onPress());
  expect(onCard).not.toHaveBeenCalled();
  act(() => mockForm.onValueChange?.(input));
  expect(mockButton.disabled).toBe(false);
  act(() => mockCheckbox.onCheckedChange(true));
  act(() => mockButton.onPress());
  expect(onCard).toHaveBeenCalledWith({
    id: expect.any(String),
    brand: 'Visa',
    last4: '4242',
    saveForLater: true,
  });
  expect(Object.keys(onCard.mock.calls[0][0]).sort()).toEqual([
    'brand',
    'id',
    'last4',
    'saveForLater',
  ]);
  expect(mockForm.value).toMatchObject({
    number: '',
    securityCode: '',
    expiry: '',
    postcode: '',
    country: '',
  });
  expect(onDone).toHaveBeenCalledTimes(1);
});
it('does not restore card input values after Back or close unmounts the entry', () => {
  const props = { card: null, onCard: jest.fn(), onDone: jest.fn() };
  act(() => {
    renderer = TestRenderer.create(themed(<LocalCheckoutCardEntry {...props} />));
  });
  act(() => mockForm.onValueChange?.(input));
  act(() => renderer.unmount());
  act(() => {
    renderer = TestRenderer.create(themed(<LocalCheckoutCardEntry {...props} />));
  });
  expect(mockForm.value).toMatchObject({
    number: '',
    securityCode: '',
    expiry: '',
    postcode: '',
    country: '',
  });
  expect(mockCheckbox.checked).toBe(false);
  expect(props.onCard).not.toHaveBeenCalled();
});

it('does not carry an earlier card saving preference into a new card', () => {
  act(() => {
    renderer = TestRenderer.create(
      themed(
        <LocalCheckoutCardEntry
          card={{ id: 'prior', brand: 'Visa', last4: '4242', saveForLater: true }}
          onCard={jest.fn()}
          onDone={jest.fn()}
        />,
      ),
    );
  });
  expect(mockCheckbox.checked).toBe(false);
  expect(mockForm.value?.number).toBe('');
});
