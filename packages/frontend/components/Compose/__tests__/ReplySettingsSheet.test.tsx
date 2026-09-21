import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ReplySettingsSheet from '../ReplySettingsSheet';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { CheckboxCard } from '@oxy.so/bloom/checkbox';
import { Switch } from '@oxy.so/bloom/switch';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/radio', () => ({ RadioGroup: 'RadioGroup' }));
jest.mock('@oxy.so/bloom/checkbox', () => ({ CheckboxCard: 'CheckboxCard' }));
jest.mock('@oxy.so/bloom/switch', () => ({ Switch: 'Switch' }));
jest.mock('@oxy.so/bloom/settings-list', () => ({ SettingsListGroup: 'SettingsListGroup', SettingsListItem: 'SettingsListItem' }));

it('preserves exclusive permissions and falls back to anyone when the last granular permission is removed', () => {
  const change = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<ReplySettingsSheet onClose={jest.fn()} replyPermission={['followers']}
    onReplyPermissionChange={change} quotesDisabled={false} onQuotesDisabledChange={jest.fn()} />); });
  act(() => renderer.root.findAllByType(CheckboxCard)[0]!.props.onCheckedChange(false));
  expect(change).toHaveBeenLastCalledWith(['anyone']);
  act(() => renderer.root.findByType(RadioGroup).props.onValueChange('nobody'));
  expect(change).toHaveBeenLastCalledWith(['nobody']);
  act(() => renderer.root.findAllByType(CheckboxCard)[1]!.props.onCheckedChange(true));
  expect(change).toHaveBeenLastCalledWith(['followers', 'following']);
  act(() => renderer.unmount());
});

it('binds the quote switch to the inverted disabled permission', () => {
  const change = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<ReplySettingsSheet onClose={jest.fn()} replyPermission={['anyone']}
    onReplyPermissionChange={jest.fn()} quotesDisabled onQuotesDisabledChange={change} />); });
  const row = renderer.root.findByType('SettingsListItem' as React.ElementType);
  const control = row.props.rightElement as React.ReactElement<React.ComponentProps<typeof Switch>>;
  expect(control.type).toBe(Switch);
  expect(control.props.checked).toBe(false);
  act(() => control.props.onCheckedChange?.(true));
  expect(change).toHaveBeenCalledWith(false);
  act(() => renderer.unmount());
});
