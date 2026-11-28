import { useAuth } from '@oxy.so/services/ui/client';
import { StorefrontSettings } from '@/components/Commerce/StorefrontSettings';
export default function CommerceSettingsPage() {
  const { user, canUsePrivateApi } = useAuth();
  return user?.id && canUsePrivateApi ? <StorefrontSettings accountId={user.id} /> : null;
}
