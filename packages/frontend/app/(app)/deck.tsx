import { Redirect } from '@/lib/navigation/router';

/** Keep deep links safe on native; the Deck workspace is desktop web only. */
export default function DeckScreen() {
  return <Redirect href="/" />;
}
