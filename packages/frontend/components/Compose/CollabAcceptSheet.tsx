import React from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxyhq/bloom/button';
import type { PostActorSummary } from '@mention/shared-types';
import { displayNameOrHandle } from '@/utils/displayName';

interface CollabAcceptSheetProps {
  inviter: PostActorSummary;
  onAccept: () => void;
  onDecline: () => void;
  onClose: () => void;
  loading?: boolean;
}

const CollabAcceptSheet: React.FC<CollabAcceptSheetProps> = ({
  inviter,
  onAccept,
  onDecline,
  onClose,
  loading = false,
}) => {
  const { t } = useTranslation();
  const inviterName = displayNameOrHandle(inviter.displayName, inviter.handle ? `@${inviter.handle}` : '');

  return (
    <View className="px-4 pb-8 pt-2 gap-4">
      <Text className="text-foreground text-xl font-bold text-center">
        {t('collab.acceptTitle', { defaultValue: 'Accept invite?' })}
      </Text>
      <Text className="text-muted-foreground text-[15px] text-center">
        {t('collab.acceptSubtitle', {
          defaultValue: '{{name}} invited you to collaborate on their post.',
          name: inviterName,
        })}
      </Text>
      <View className="gap-3">
        <Text className="text-foreground text-[15px]">
          {t('collab.acceptAttribution', { defaultValue: 'Your username will be added to this post as a co-author.' })}
        </Text>
        <Text className="text-foreground text-[15px]">
          {t('collab.acceptDistribution', { defaultValue: 'The post will be shared with your followers and appear on your profile.' })}
        </Text>
        <Text className="text-foreground text-[15px]">
          {t('collab.acceptVisibility', { defaultValue: 'If any collaborator has a public account, the post is public.' })}
        </Text>
      </View>
      <View className="gap-2 mt-2">
        <Button onPress={onAccept} disabled={loading}>
          {t('collab.accept', { defaultValue: 'Accept' })}
        </Button>
        <Button variant="secondary" onPress={onDecline} disabled={loading}>
          {t('collab.decline', { defaultValue: 'Decline' })}
        </Button>
        <Button variant="ghost" onPress={onClose} disabled={loading}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </View>
    </View>
  );
};

export default CollabAcceptSheet;
