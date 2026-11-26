/**
 * DEV ONLY: the three forms of Settings -> Notifications the proof measures, each
 * as the element its consumer draws (`README.md`):
 *
 * - `original`: the TypeScript screen as it shipped (a component, `<Original />`);
 * - `cleaned`: the same in the embedded language at its best (a `view()`);
 * - `bloom`: the `.bloom` port the app now uses (a `view`, compiled by bloomc).
 *
 * A view is a node factory, so it is drawn with `toElement(View())`, as
 * `settingsPages.tsx` draws the port. Each is required only when asked for.
 */
import { toElement } from '@oxy.so/bloom-language';
import { createElement, type ComponentType, type ReactElement } from 'react';

export type ProofScreen = 'original' | 'cleaned' | 'bloom';
export const PROOF_SCREENS: ProofScreen[] = ['original', 'cleaned', 'bloom'];

type ViewFactory = () => Parameters<typeof toElement>[0];

export function loadScreen(name: ProofScreen): () => ReactElement {
  switch (name) {
    case 'original': {
      const Original: ComponentType = require('./variants/original').default;
      const element = createElement(Original);
      return () => element;
    }
    case 'cleaned': {
      const view: ViewFactory = require('./variants/cleaned').NotificationSettingsScreen;
      return () => toElement(view());
    }
    case 'bloom': {
      const view: ViewFactory =
        require('@/components/settings/pages/notifications.bloom').NotificationSettingsScreen;
      return () => toElement(view());
    }
  }
}
