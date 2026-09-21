import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';

/** Inline social-template invitation; the shell owns any fixed edge surfaces. */
export const SignInBanner = memo(function SignInBanner() {
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <View className="bg-primary">
      <View className="flex-row items-center justify-center px-4 py-3 gap-4 w-full">
        <View className="flex-1">
          <Text className="text-primary-foreground text-base font-bold">
            {t('Don’t miss what’s happening')}
          </Text>
          <Text className="text-primary-foreground/85 text-[13px] mt-0.5">
            {t('People on Mention are the first to know.')}
          </Text>
        </View>
        <Button
          variant="inverse"
          size="small"
          style={{ borderRadius: 100, paddingHorizontal: 20 }}
          onPress={() => signIn().catch(() => {})}
        >
          {t('Sign In')}
        </Button>
      </View>
    </View>
  );
});
