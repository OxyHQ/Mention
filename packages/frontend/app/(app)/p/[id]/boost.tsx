import { Redirect, useLocalSearchParams } from 'expo-router';

/** The old URL of the reposts screen (`/p/:id/boost`): links already out there keep working. */
export default function PostBoostRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/p/${id}/reposts` as never} />;
}
