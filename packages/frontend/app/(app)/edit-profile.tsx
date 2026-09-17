import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EditProfileForm } from '@/components/Profile/EditProfile/EditProfileForm';

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  return (
    <View className="flex-1">
      <PageHeader
        title={t('profile.editProfile')}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <EditProfileForm />
    </View>
  );
}
