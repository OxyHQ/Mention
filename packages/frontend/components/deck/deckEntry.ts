import type { DeckSnapshot } from './deckSettings';

/**
 * The fixed application column replaces the original untouched Explore slot.
 * Keep any customized legacy column as an additional column, without rewriting
 * the saved workspace or discarding its history or presentation.
 */
export function isDefaultLeadingDeckPanel({
  order,
  panels,
}: Pick<DeckSnapshot, 'order' | 'panels'>) {
  const first = panels[order[0]];
  if (order[0] !== 'deck-0' || first?.source !== 'explore') return false;
  if (
    first.width !== 390 ||
    !first.resizable ||
    first.appearance !== 'solid' ||
    first.colorPreset ||
    first.liveUpdates ||
    first.pauseWhileReading === false ||
    Object.keys(first.scrollOffsets ?? {}).length
  )
    return false;
  const history = first.navigation;
  return (
    !history ||
    (history.index === 0 &&
      history.entries.length === 1 &&
      history.entries[0].name === '/explore' &&
      !Object.keys(history.entries[0].params ?? {}).length)
  );
}
