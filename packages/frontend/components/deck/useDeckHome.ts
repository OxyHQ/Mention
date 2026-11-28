import { useAuth } from '@oxy.so/services/ui/client';
import { useDeckAvailable } from './useDeckAvailable';
import { useDeckSettings } from './deckSettings';

/** Root-shell policy only: embedded Home routes always remain ordinary feeds. */
export function useDeckHome() {
  const available = useDeckAvailable();
  const { user, isAuthResolved } = useAuth();
  const viewer = user?.id ? `user:${user.id}` : 'anonymous';
  return useDeckSettings(
    (state) => available && isAuthResolved && state.viewer === viewer && state.homeScreen === true,
  );
}
