/**
 * The notifications header in the Bloom language: Bloom's PageHeader on
 * Android (its floating controls on the lens) and the web, the navigation bar
 * on iOS. Its controls are the JSX header's: subtle, neutral, icon-only.
 */
import type { ReactElement } from 'react';
import { Button, Header, Icon, toElement, type IconComponent } from '@oxy.so/bloom-language';
import { RiCheckDoubleLine } from '@oxy.so/bloom/icons/RiCheckDoubleLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiNotification3Fill } from '@oxy.so/bloom/icons/RiNotification3Fill';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';

interface HeaderAction {
  label: string;
  onPress: () => void;
  busy?: boolean;
}

export interface NotificationsHeaderProps {
  title: string;
  markAllRead: HeaderAction | undefined;
  privateMentions: HeaderAction | undefined;
  subscriptions: HeaderAction;
  settings: HeaderAction;
}

function control(icon: IconComponent, action: HeaderAction | undefined) {
  if (!action) return null;
  return Button(Icon(icon))
    .style('subtle')
    .tint('neutral')
    .shape('circle')
    .label(action.label)
    .disabled(action.busy ?? false)
    .onPress(action.onPress);
}

export function notificationsHeader(props: NotificationsHeaderProps): ReactElement {
  return toElement(
    Header(props.title).toolbar(
      control(RiCheckDoubleLine, props.markAllRead),
      control(RiLockLine, props.privateMentions),
      control(RiNotification3Fill, props.subscriptions),
      control(RiSettings3Line, props.settings),
    ),
  );
}
