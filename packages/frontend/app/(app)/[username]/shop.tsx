import ProfileScreen from '@/components/ProfileScreen';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
export default function ProfileShopRoute() {
  const username = useRoutedProfileUsername();
  return <ProfileScreen username={username} tab="shop" />;
}
