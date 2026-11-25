import { Redirect, useLocalSearchParams } from 'expo-router';

/** The old URL of the reposts tab (`/@name/boosts`): links already out there keep working. */
export default function ProfileBoostsRedirect() {
  const { username } = useLocalSearchParams<{ username: string }>();
  return <Redirect href={`/${username}/reposts` as never} />;
}
