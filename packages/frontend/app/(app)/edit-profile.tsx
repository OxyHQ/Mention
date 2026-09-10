import React from 'react';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EditProfileForm } from '@/components/Profile/EditProfile/EditProfileForm';

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('profile.editProfile'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <EditProfileForm />
      </ThemedView>
    </SafeAreaView>
  );
}
