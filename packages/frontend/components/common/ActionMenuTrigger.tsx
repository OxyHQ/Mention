import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';

import { buildMenuGroups, type ActionMenuAction } from '@/components/common/actionMenuGroups';

export type ActionMenuGroups = ActionMenuAction[][];

interface ActionMenuTriggerProps {
  /** Accessible name of the trigger and of the menu — what the menu acts on. */
  label: string;
  /**
   * The groups to offer, or a function that builds them. A function runs when
   * the menu is OPENED, so a row in a long list holds one stable callback
   * instead of a menu built for every item; it may be async, and the menu opens
   * once it settles.
   */
  groups: ActionMenuGroups | (() => ActionMenuGroups | Promise<ActionMenuGroups>);
  /** The single element that opens the menu (the ⋯ button). */
  children: ReactNode;
}

/**
 * The app's ⋯ menu: Bloom's `DropdownMenu` — an anchored popover on a pointer,
 * a sheet on a phone. The menu content mounts only while open, so a feed of a
 * thousand posts renders a trigger each and nothing else.
 *
 * A row's `onPress` runs AFTER the menu closes, so an action is free to open
 * another surface.
 */
export function ActionMenuTrigger({ label, groups, children }: ActionMenuTriggerProps) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<ActionMenuGroups>([]);
  // Latest open request, so a slow build that finishes after the reader has
  // already dismissed (or reopened) the menu cannot pop it open.
  const request = useRef(0);

  const onOpenChange = useCallback(
    (next: boolean) => {
      const id = ++request.current;
      if (!next) {
        setOpen(false);
        return;
      }
      const built = typeof groups === 'function' ? groups() : groups;
      if (!(built instanceof Promise)) {
        setResolved(built);
        setOpen(true);
        return;
      }
      void built
        .then((value) => {
          if (request.current !== id) return;
          setResolved(value);
          setOpen(true);
        })
        .catch(() => {});
    },
    [groups],
  );

  const close = useCallback(() => setOpen(false), []);
  const visible = open ? buildMenuGroups(resolved, close) : [];

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild label={label}>
        {children}
      </DropdownMenuTrigger>
      {open && visible.length > 0 ? (
        <DropdownMenuContent label={label}>
          {visible.map((actions, index) => (
            <Fragment key={actions[0].label}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    leading={action.icon}
                    variant={action.color ? 'destructive' : 'default'}
                    onPress={action.onPress}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}
