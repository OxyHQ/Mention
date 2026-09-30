import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { InverseButton } from '@oxy.so/bloom/button';

/**
 * The anonymous reader's invitation to sign in. `app/(app)/_layout.tsx` hands
 * it to the app shell as the bottom bar, which pins it to the bottom edge and
 * reserves its height at the end of the column; it paints no position of its own.
 */
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
        <InverseButton
          size="sm"
          style={{ borderRadius: 100, paddingHorizontal: 20 }}
          onPress={() => signIn().catch(() => {})}
        >
          {t('Sign In')}
        </InverseButton>
      </View>
    </View>
  );
});
