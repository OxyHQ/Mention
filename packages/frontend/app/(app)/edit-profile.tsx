import { useEffect } from 'react';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { useSafeBack } from '@/hooks/useSafeBack';

/** Compatibility address: Edit profile is a Settings page, not a screen. */
export default function EditProfileScreen() {
  const safeBack = useSafeBack();
  useEffect(() => {
    requestSettings('/settings/edit-profile');
    safeBack();
  }, [safeBack]);
  return null;
}
