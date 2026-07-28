/**
 * The action menu's data contract, kept free of React and Bloom so it can be
 * unit-tested: `@oxyhq/bloom/dialog` resolves to untransformed source under
 * Metro's `react-native` export condition, which jest cannot load.
 */
import type { ReactNode } from 'react';

export interface ActionMenuAction {
  /** Rendered on the trailing edge — an icon element, sized by the caller. */
  icon: ReactNode;
  label: string;
  onPress: () => void;
  /** Text colour for destructive entries; omit for the default foreground. */
  color?: string;
}

/**
 * Drop the empty groups a caller passed (every menu is assembled from
 * conditional groups — "insights" and "delete" exist only for an owner) and
 * wrap each row so pressing it CLOSES the menu before running the action. The
 * close has to come first: several actions open another surface, and stacking
 * a report sheet on top of a live menu is exactly what the old bottom-sheet
 * menu did by hand at each call site, forgetting it in a handful of them.
 */
export function buildMenuGroups(
  groups: ActionMenuAction[][],
  close: () => void,
): ActionMenuAction[][] {
  return groups
    .filter((actions) => actions.length > 0)
    .map((actions) =>
      actions.map((action) => ({
        ...action,
        onPress: () => {
          close();
          action.onPress();
        },
      })),
    );
}
