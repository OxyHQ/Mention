import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Admonition } from '@oxy.so/bloom/admonition';

/**
 * Tells an author their post was restricted. Only people who may still read a
 * restricted post receive it, so its status is the whole condition.
 */
export function RestrictedPostNotice({ status }: { status: string | undefined }) {
  const { t } = useTranslation();
  if (status !== 'restricted') return null;
  return (
    <View className="px-4 pt-3 pb-1" testID="restricted-post-notice">
      <Admonition type="warning">{t('post.restrictedNotice')}</Admonition>
    </View>
  );
}
