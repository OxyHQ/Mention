import type { PanelRouteDefinition } from '@oxy.so/bloom/panel-routing';
// Deck is desktop-only. Do not bundle another route graph into native apps.
export const deckRoutes: readonly PanelRouteDefinition[] = [];
export const retryFailedDeckRoutes = () => {};
