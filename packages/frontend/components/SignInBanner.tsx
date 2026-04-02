import React, { memo } from 'react';
import { View, Text, Platform, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

export const SignInBanner = memo(function SignInBanner() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <View
      className="bg-primary z-[999]"
      style={[
        Platform.select({
          web: { position: 'sticky' as any, bottom: 0 },
          default: { position: 'absolute', bottom: 0, left: 0, right: 0 },
        }),
        { paddingBottom: Platform.OS === 'web' ? 0 : insets.bottom },
      ]}
    >
      <View className="flex-row items-center justify-center px-4 py-3 gap-4 w-full">
        <View className="flex-1">
          <Text className="text-primary-foreground text-base font-bold">
            {t('Don\u2019t miss what\u2019s happening')}
          </Text>
          <Text className="text-primary-foreground/85 text-[13px] mt-0.5">
            {t('People on Mention are the first to know.')}
          </Text>
        </View>
        <TouchableOpacity
          className="bg-primary-foreground rounded-full px-5 py-2"
          activeOpacity={0.8}
          onPress={() => signIn().catch(() => {})}
        >
          <Text className="text-primary text-sm font-bold">
            {t('Sign In')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});
