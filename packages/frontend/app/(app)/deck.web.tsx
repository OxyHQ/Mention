import { Redirect } from '@/lib/navigation/router';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';

/** Bloom's root panel descriptors own the columns; Expo owns this route. */
export default function DeckScreen() {
  const available = useDeckAvailable();
  return available ? null : <Redirect href="/" />;
}
