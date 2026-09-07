import { useLocalSearchParams } from 'expo-router';

/**
 * The handle the URL names, with its leading `@` stripped.
 *
 * THE ONE PLACE profile code reads the `[username]` segment. It is a hook about
 * the ROUTE, named for exactly that, and only route-level code calls it: the
 * `[username]` layout, the screen files under it, and the two family screens.
 *
 * Everything downstream — `useProfileAccount`, `usePersonProfileView`,
 * `ProfileScreen` — takes a handle as a value instead of reaching for the URL
 * itself. That inversion is the whole point. When the lookup went and found its
 * own segment, a caller that had a handle but no segment (the `/you` tab) could
 * only be served by an override parameter, and that parameter then had to carry
 * a second, unrelated meaning as well. One named reader, and the question stops
 * arising.
 *
 * Returns `''` when the URL names nobody, which is what `useProfileData`
 * already treats as "nothing to fetch".
 */
export function useRoutedProfileUsername(): string {
  const { username } = useLocalSearchParams<{ username: string }>();
  if (typeof username !== 'string') return '';
  return username.startsWith('@') ? username.slice(1) : username;
}
