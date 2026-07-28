import React, { memo, useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';
import { cn } from '@/lib/utils';

interface ActionMenuGroupProps {
  actions: ActionMenuAction[];
}

/**
 * One row of an action menu. Grouped rows share a rounded card: only the first
 * and last corners are round, and a hairline gap separates the rows — the iOS
 * grouped-list shape the post menu established.
 */
const ActionMenuRow = memo(function ActionMenuRow({
  action,
  isFirst,
  isLast,
}: {
  action: ActionMenuAction;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <TouchableOpacity
      className="bg-surface flex-row items-center justify-between py-3 px-3.5"
      style={{
        borderTopLeftRadius: isFirst ? 16 : 0,
        borderTopRightRadius: isFirst ? 16 : 0,
        borderBottomLeftRadius: isLast ? 16 : 0,
        borderBottomRightRadius: isLast ? 16 : 0,
        marginBottom: isLast ? 0 : 4,
      }}
      onPress={action.onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      <Text
        className={cn('text-base font-medium', !action.color && 'text-foreground')}
        style={action.color ? { color: action.color } : undefined}
      >
        {action.label}
      </Text>
      <View className="ml-3">{action.icon}</View>
    </TouchableOpacity>
  );
});

/**
 * A group of related actions inside an action menu.
 *
 * The post menu and the profile menu are the same surface and must look it —
 * they used to be two implementations, and the profile one (bare full-width
 * buttons on the sheet background, no grouping) was visibly the poor relation.
 * Compose a menu from one or more groups; each renders as its own card.
 */
export const ActionMenuGroup = memo(function ActionMenuGroup({ actions }: ActionMenuGroupProps) {
  if (actions.length === 0) return null;

  return (
    <View className="mb-1">
      {actions.map((action, index) => (
        <ActionMenuRow
          key={action.label}
          action={action}
          isFirst={index === 0}
          isLast={index === actions.length - 1}
        />
      ))}
    </View>
  );
});

interface ActionMenuRequest {
  /** Accessibility label for the surface — what the menu acts on. */
  label: string;
  /** One card per group. Empty groups are dropped. */
  groups: ActionMenuAction[][];
}

let openMenuRequest: ((request: ActionMenuRequest) => void) | null = null;
let closeMenu: (() => void) | null = null;

/**
 * Open the app's action menu. Imperative on purpose: the menu is a SINGLE
 * surface mounted once at the root (see `ActionMenuHost`), so a feed of a
 * thousand posts mounts one dialog, not one per row — the reason the post menu
 * used to push its rows into a shared bottom sheet instead of rendering its own.
 *
 * A row's `onPress` runs AFTER the menu closes, so an action is free to open
 * another surface.
 */
export function showActionMenu(request: ActionMenuRequest): void {
  openMenuRequest?.(request);
}

/** Close the action menu without running an action. */
export function hideActionMenu(): void {
  closeMenu?.();
}

/**
 * The action menu as a Bloom `Dialog`: a centered card from `md` up and a bottom
 * sheet below it. One surface for the post menu and the profile menu, so they
 * cannot drift apart again — and on desktop neither of them slides up from the
 * bottom of a 1400px-wide window any more.
 *
 * Mount once, next to the other root-level dialog hosts.
 */
export function ActionMenuHost() {
  const control = useDialogControl();
  const [request, setRequest] = useState<ActionMenuRequest | null>(null);

  useEffect(() => {
    openMenuRequest = (next) => {
      setRequest(next);
      control.open();
    };
    closeMenu = () => control.close();
    return () => {
      openMenuRequest = null;
      closeMenu = null;
    };
  }, [control]);

  const groups = useMemo(
    () => buildMenuGroups(request?.groups ?? [], control.close),
    [request, control],
  );

  return (
    <Dialog
      control={control}
      label={request?.label ?? ''}
      placement={{ base: 'bottom', md: 'center' }}
      // The cards own their gutter; the Dialog's default 20px inset would
      // double it.
      contentPadding={0}
    >
      <View className="p-4 gap-2">
        {groups.map((actions) => (
          <ActionMenuGroup key={actions[0].label} actions={actions} />
        ))}
      </View>
    </Dialog>
  );
}
