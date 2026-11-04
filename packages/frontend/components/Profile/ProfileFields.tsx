import { memo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Item } from '@oxy.so/bloom/item';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import type { RemoteProfileField } from '@mention/shared-types/profile';
import { LinkifiedText } from '@/components/common/LinkifiedText';

/**
 * A federated profile's metadata table (ActivityPub `PropertyValue` rows). The
 * server sends each value as plain text — the remote HTML reduced, each link to
 * its URL — so it is only re-linked here, never rendered as markup.
 */
export const ProfileFields = memo(function ProfileFields({
  fields,
}: {
  fields: readonly RemoteProfileField[] | undefined;
}) {
  const { t } = useTranslation();
  if (!fields || fields.length === 0) return null;
  return (
    <View className="mb-3">
      {fields.map((field) => (
        <Item
          key={`${field.name}:${field.value}`}
          size="sm"
          title={field.name}
          subtitle={<LinkifiedText text={field.value} className="text-foreground text-[15px]" />}
          trailing={
            field.verifiedAt ? (
              <Badge
                content={t('profile.fields.verified')}
                icon={RiCheckboxCircleLine}
                color="success"
                size="label-small"
                variant="subtle"
              />
            ) : undefined
          }
        />
      ))}
    </View>
  );
});
