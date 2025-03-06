import React, { useContext } from 'react';
import { View } from 'react-native';
import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { useTranslation } from 'react-i18next';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import Feed from '@/components/Feed';
import NoUpdatesSvg from '@/assets/images/illustrations/no_updates.svg';

export default function HomeScreen() {
  const { t } = useTranslation();
  const session = useContext(SessionContext);

  if (!session?.getCurrentUserId()) {
    return (
      <View className="flex-1 justify-center items-center gap-4">
        <NoUpdatesSvg width={200} height={200} />
        <ThemedText>{t('Please log in to view your feed')}</ThemedText>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <Header options={{ title: t('Home') }} />
      <Feed type="home" />
    </View>
  );
}
