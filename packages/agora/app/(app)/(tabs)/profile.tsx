import { Redirect } from 'expo-router';
import { useAuth } from '@oxyhq/services';

export default function ProfileRedirect() {
  const { user } = useAuth();
  const username = user?.username;

  if (username) {
    return <Redirect href={{ pathname: '/(app)/(tabs)/[username]', params: { username: '@' + username } }} />;
  }

  return <Redirect href="/(app)/(tabs)" />;
}
