import { Platform, ScrollView, Text, View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { OxyOneScreen } from '@oxy.so/services/screens';
import { useTranslation } from 'react-i18next';
import { useSafeBack } from '@/hooks/useSafeBack';

/** Mention Plus comes with every paid Oxy One plan, so this is Oxy One's own plans screen. */
export default function PlusScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const body = (
    <>
      <Text className="text-[15px] text-muted-foreground mb-4">{t('plus.lead')}</Text>
      <OxyOneScreen />
    </>
  );

  return (
    <View className="flex-1">
      <PageHeader
        title={t('plus.title')}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      {Platform.OS === 'web' ? (
        <View className="px-4 pt-4 pb-8">{body}</View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-screen-margin pt-4 pb-8"
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      )}
    </View>
  );
}
