import type React from 'react';
import type { TFunction } from 'i18next';
import TestRenderer, { act } from 'react-test-renderer';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { Chip, HStack, Icon, RawText, Text, toElement } from '@oxy.so/bloom-language';
import { AudienceMenu } from '../AudienceMenu';
import { ReplySettingsMenu } from '../ReplySettingsMenu';

/**
 * The composer's audience and who-can-reply menus are the language's `Menu` in
 * the dropdown style: the trigger the composer draws opens them, the trigger
 * is named by the menu, a choice is a radio row marked while it is the value,
 * and a toggle is a checkbox row.
 *
 * Bloom's dropdown menu does not load under Jest (`test-support/bloomDropdownMenu.js`),
 * so its parts here keep what the menu hands them: the trigger clones its child
 * with the press that opens the menu and its name, as Bloom's `TriggerSlot`
 * does; a radio group hands its value and setter to its rows.
 */
type MockOpenState = [boolean, (open: boolean) => void];
type MockRadio = { value: string | undefined; onValueChange: (value: string) => void };
type MockProps = { children?: React.ReactNode; keepOpen?: boolean };

jest.mock('@oxy.so/bloom/dropdown-menu', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { Text: RNText, View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Open = R.createContext<MockOpenState>([false, () => {}]);
  const Radio = R.createContext<MockRadio>({ value: undefined, onValueChange: () => {} });
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) => R.createElement(Open.Provider, { value: [open, onOpenChange] }, children),
    DropdownMenuTrigger: ({ children, label }: { children: React.ReactElement; label: string }) => {
      const [open, setOpen] = R.useContext(Open);
      return R.cloneElement(R.Children.only(children), {
        onPress: () => setOpen(true),
        accessibilityLabel: label,
        'aria-expanded': open,
      } as object);
    },
    DropdownMenuContent: ({ children }: MockProps) => R.createElement(View, null, children),
    DropdownMenuLabel: ({ children }: MockProps) =>
      R.createElement(RNText, { accessibilityRole: 'header' }, children),
    DropdownMenuSeparator: () => R.createElement(View, { testID: 'separator' }),
    DropdownMenuGroup: ({ children }: MockProps) => R.createElement(R.Fragment, null, children),
    DropdownMenuItem: ({ children }: MockProps) =>
      R.createElement(RNText, { accessibilityRole: 'menuitem' }, children),
    DropdownMenuRadioGroup: ({ value, onValueChange, children }: MockRadio & MockProps) =>
      R.createElement(Radio.Provider, { value: { value, onValueChange } }, children),
    DropdownMenuRadioItem: ({ value, keepOpen, children }: MockProps & { value: string }) => {
      const group = R.useContext(Radio);
      return R.createElement(
        RNText as React.ElementType,
        {
          accessibilityRole: 'radio',
          accessibilityState: { checked: group.value === value },
          keepOpen,
          onPress: () => group.onValueChange(value),
        },
        children,
      );
    },
    DropdownMenuCheckboxItem: ({
      checked,
      onCheckedChange,
      keepOpen,
      children,
    }: MockProps & { checked: boolean; onCheckedChange: (checked: boolean) => void }) =>
      R.createElement(
        RNText as React.ElementType,
        {
          accessibilityRole: 'checkbox',
          accessibilityState: { checked },
          keepOpen,
          onPress: () => onCheckedChange(!checked),
        },
        children,
      ),
  };
});

const t = ((key: string) => key) as unknown as TFunction;

function render(node: Parameters<typeof toElement>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>{toElement(node)}</BloomThemeProvider>,
    );
  });
  return renderer;
}

/** The trigger the menu named and handed its press: the host the composer drew. */
function trigger(renderer: TestRenderer.ReactTestRenderer, name: string) {
  const found = renderer.root.findAll(
    (node) =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === name &&
      typeof node.props.onPress === 'function' &&
      'aria-expanded' in node.props,
  );
  return found[found.length - 1];
}

/** The open menu's rows: role, title, checked state and whether it keeps the menu open. */
function rows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(
      (node) =>
        String(node.type) === 'Text' &&
        ['header', 'radio', 'checkbox'].includes(node.props.accessibilityRole as string),
    )
    .map((node) => ({
      role: node.props.accessibilityRole as string,
      title: node.children.join(''),
      checked: node.props.accessibilityState?.checked as boolean | undefined,
      keepOpen: node.props.keepOpen as boolean | undefined,
    }));
}

function press(renderer: TestRenderer.ReactTestRenderer, title: string) {
  const row = renderer.root.find(
    (node) =>
      String(node.type) === 'Text' &&
      typeof node.props.onPress === 'function' &&
      node.children.join('') === title,
  );
  act(() => row.props.onPress());
}

const chip = () =>
  Chip(Icon(RiEarthLine), Text('Everyone'), Icon(RiArrowDownSLine))
    .size('xl')
    .style('subtle')
    .testID('compose-audience');

it('opens the audience menu from the chip, as a radio choice under its title', () => {
  const onAudienceChange = jest.fn();
  const renderer = render(AudienceMenu(chip(), { audience: 'public', onAudienceChange, t }));
  expect(rows(renderer)).toEqual([]);

  act(() => trigger(renderer, 'compose.audience.title').props.onPress());
  expect(rows(renderer)).toEqual([
    { role: 'header', title: 'compose.audience.title', checked: undefined, keepOpen: undefined },
    { role: 'radio', title: 'compose.audience.public', checked: true, keepOpen: false },
    { role: 'radio', title: 'compose.audience.direct', checked: false, keepOpen: false },
  ]);

  press(renderer, 'compose.audience.direct');
  expect(onAudienceChange).toHaveBeenCalledWith('direct');
});

describe('the who-can-reply menu', () => {
  const pill = () =>
    HStack(Icon(RiEarthLine).size('14').foreground('muted'), RawText('Anyone'))
      .align('center')
      .background('surface')
      .pressFade('70');

  function open(replyPermission: ('anyone' | 'nobody' | 'followers')[], quotesDisabled = false) {
    const settings = {
      replyPermission,
      onReplyPermissionChange: jest.fn(),
      quotesDisabled,
      onQuotesDisabledChange: jest.fn(),
    };
    const renderer = render(ReplySettingsMenu(pill(), { ...settings, t }));
    expect(rows(renderer)).toEqual([]);
    act(() => trigger(renderer, 'compose.replySettings.title').props.onPress());
    return { renderer, settings };
  }

  it('lists the choice, the granular audiences and quotes, each keeping the menu open', () => {
    const { renderer } = open(['anyone']);
    expect(rows(renderer)).toEqual([
      {
        role: 'header',
        title: 'compose.replySettings.whoCanReply',
        checked: undefined,
        keepOpen: undefined,
      },
      { role: 'radio', title: 'compose.replySettings.anyone', checked: true, keepOpen: true },
      { role: 'radio', title: 'compose.replySettings.nobody', checked: false, keepOpen: true },
      { role: 'checkbox', title: 'Your followers', checked: false, keepOpen: true },
      { role: 'checkbox', title: 'People you follow', checked: false, keepOpen: true },
      { role: 'checkbox', title: 'People you mention', checked: false, keepOpen: true },
      {
        role: 'checkbox',
        title: 'compose.replySettings.allowQuotes',
        checked: true,
        keepOpen: true,
      },
    ]);
    expect(
      renderer.root.findAll(
        (node) => String(node.type) === 'View' && node.props.testID === 'separator',
      ),
    ).toHaveLength(2);
  });

  it('marks no choice while the audiences are granular, and changes what is pressed', () => {
    const { renderer, settings } = open(['followers'], true);
    const checked = rows(renderer).map((row) => row.checked);
    expect(checked).toEqual([undefined, false, false, true, false, false, false]);

    press(renderer, 'compose.replySettings.nobody');
    expect(settings.onReplyPermissionChange).toHaveBeenLastCalledWith(['nobody']);
    press(renderer, 'People you follow');
    expect(settings.onReplyPermissionChange).toHaveBeenLastCalledWith(['followers', 'following']);
    press(renderer, 'compose.replySettings.allowQuotes');
    expect(settings.onQuotesDisabledChange).toHaveBeenLastCalledWith(false);
  });
});
