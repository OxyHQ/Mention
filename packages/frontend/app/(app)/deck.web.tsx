import { Redirect } from '@/lib/navigation/router';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useEffect } from 'react';
import { useDeckSettings } from '@/components/deck/deckSettings';

/** Bloom's root panel descriptors own the columns; Expo owns this route. */
export default function DeckScreen() {
  const available = useDeckAvailable();
  useEffect(() => {
    if (available) useDeckSettings.getState().setDeckEnabled(true);
  }, [available]);
  return <Redirect href="/" />;
}
