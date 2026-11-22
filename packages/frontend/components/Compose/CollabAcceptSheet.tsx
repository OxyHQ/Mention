import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PostUser } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { displayNameOrHandle } from '@/utils/displayName';

import {
  Button as LButton,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface CollabAcceptSheetProps {
  inviter: PostUser;
  /** Settles once the answer is sent; the buttons stay disabled until then. */
  onAccept: () => Promise<unknown>;
  onDecline: () => Promise<unknown>;
  onClose: () => void;
}

const CollabAcceptSheet: React.FC<CollabAcceptSheetProps> = ({
  inviter,
  onAccept,
  onDecline,
  onClose,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const answer = (send: () => Promise<unknown>) => async () => {
    setLoading(true);
    try {
      await send();
    } finally {
      setLoading(false);
    }
  };
  const inviterHandle = getNormalizedUserHandle(inviter);
  const inviterName = displayNameOrHandle(
    inviter.name?.displayName,
    inviterHandle ? `@${inviterHandle}` : '',
  );

  return toElement(
    VStack(
      RawText(t('collab.acceptTitle', { defaultValue: 'Accept invite?' }))
        .foreground('foreground')
        .font('xl')
        .leading('28px')
        .weight('bold')
        .textAlign('center'),
      RawText(
        t('collab.acceptSubtitle', {
          defaultValue: '{{name}} invited you to collaborate on their post.',
          name: inviterName,
        }),
      )
        .foreground('muted')
        .font('md')
        .textAlign('center'),
      VStack(
        RawText(
          t('collab.acceptAttribution', {
            defaultValue: 'Your username will be added to this post as a co-author.',
          }),
        )
          .foreground('foreground')
          .font('md'),
        RawText(
          t('collab.acceptDistribution', {
            defaultValue: 'The post will be shared with your followers and appear on your profile.',
          }),
        )
          .foreground('foreground')
          .font('md'),
        RawText(
          t('collab.acceptVisibility', {
            defaultValue: 'If any collaborator has a public account, the post is public.',
          }),
        )
          .foreground('foreground')
          .font('md'),
      ).spacing('md'),
      VStack(
        LButton(LText(t('collab.accept', { defaultValue: 'Accept' })))
          .onPress(answer(onAccept))
          .disabled(loading),
        LButton(LText(t('collab.decline', { defaultValue: 'Decline' })))
          .style('subtle')
          .tint('neutral')
          .onPress(answer(onDecline))
          .disabled(loading),
        LButton(LText(t('common.cancel', { defaultValue: 'Cancel' })))
          .style('plain')
          .tint('neutral')
          .onPress(onClose)
          .disabled(loading),
      )
        .spacing('sm')
        .margin('top', 'sm'),
    )
      .padding('horizontal', 'lg')
      .padding('bottom', '3xl')
      .padding('top', 'sm')
      .spacing('lg'),
  );
};

export default CollabAcceptSheet;
