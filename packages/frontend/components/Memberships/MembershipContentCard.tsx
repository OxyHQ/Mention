import { useState } from 'react';
import { Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import type { MembershipContent, MembershipBenefit } from '@mention/shared-types';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';
import { confirmDestructive } from '@/utils/alerts';

import {
  Button as LButton,
  Card as LCard,
  Embed,
  HStack,
  RawText,
  Text as LText,
  TextEditor,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function MembershipContentCard({
  content,
  viewerId,
  manager,
  benefits,
  onChange,
  onThread,
}: {
  content: MembershipContent;
  viewerId: string;
  manager: boolean;
  benefits: MembershipBenefit[];
  onChange: () => Promise<void>;
  onThread?: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const action = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
      await onChange();
    } catch (failure) {
      setError(
        getErrorMessage(failure, t('memberships.failed', 'The action could not be completed.')),
      );
    } finally {
      setPending(false);
    }
  };
  return toElement(
    LCard(
      VStack(
        content.title
          ? RawText(content.title)
              .font('18')
              .leading('28px')
              .weight('semibold')
              .foreground('foreground')
          : null,
        RawText(content.body).selectable().foreground('foreground'),
        content.poll
          ? VStack(
              Embed(
                content.poll.options.map((option) => (
                  <Button
                    key={option.id}
                    appearance={content.poll?.selectedOptionId === option.id ? 'solid' : 'outline'}
                    disabled={
                      pending ||
                      !benefits.includes('polls_vote') ||
                      Date.parse(content.poll?.endsAt ?? '') <= Date.now()
                    }
                    onPress={() => {
                      void action(() => membershipsService.vote(content.id, option.id));
                    }}
                  >
                    {`${option.text} · ${option.votes}`}
                  </Button>
                )),
              ),
              RawText(
                t('memberships.pollEnds', 'Closes {{date}}', {
                  date: new Date(content.poll.endsAt).toLocaleString(),
                }),
              ).foreground('muted'),
            ).spacing('sm')
          : null,
        Embed(
          content.media.map((media, index) =>
            toElement(
              LButton(
                LText(
                  t('memberships.openAttachment', 'Open attachment {{number}}', {
                    number: index + 1,
                  }),
                ),
              )
                .style('outline')
                .disabled(pending || !benefits.includes('media_download'))
                .onPress(() => {
                  void action(async () => {
                    const { url } = await membershipsService.download(content.id, media.id);
                    // URL exists only for this gesture; never cache it on a row or in query storage.
                    await Linking.openURL(url);
                  });
                }),
              media.id,
            ),
          ),
        ),
        HStack(
          onThread
            ? LButton(LText(t('memberships.discussion', 'Discussion')))
                .size('sm')
                .style('plain')
                .onPress(onThread)
            : null,
          LButton(
            LText(
              reported ? t('memberships.reported', 'Reported') : t('memberships.report', 'Report'),
            ),
          )
            .size('sm')
            .style('plain')
            .disabled(pending || reported)
            .onPress(() => setReport('')),
          viewerId === content.authorOxyUserId || manager
            ? LButton(LText(t('memberships.removeAction', 'Remove')))
                .size('sm')
                .style('plain')
                .disabled(pending)
                .onPress(() => {
                  void action(async () => {
                    if (
                      await confirmDestructive(
                        t('memberships.remove', 'Remove content?'),
                        t(
                          'memberships.removeHelp',
                          'Members will no longer be able to open this content.',
                        ),
                        t('memberships.removeAction', 'Remove'),
                        t('common.cancel', 'Cancel'),
                      )
                    )
                      await membershipsService.removeContent(content.id);
                  });
                })
            : null,
          manager && viewerId !== content.authorOxyUserId
            ? LButton(LText(t('memberships.revokeAction', 'Revoke membership')))
                .size('sm')
                .style('plain')
                .disabled(pending)
                .onPress(() => {
                  void action(async () => {
                    if (
                      await confirmDestructive(
                        t('memberships.revoke', 'Revoke membership?'),
                        t(
                          'memberships.revokeHelp',
                          'This member will lose access and cannot rejoin on their own.',
                        ),
                        t('memberships.revokeAction', 'Revoke membership'),
                        t('common.cancel', 'Cancel'),
                      )
                    )
                      await membershipsService.revoke(content.communityId, content.authorOxyUserId);
                  });
                })
            : null,
        )
          .wrap()
          .spacing('sm'),
        report !== null
          ? VStack(
              TextEditor([report, setReport])
                .label(t('memberships.reportReason', 'Reason for report'))
                .maxLength(2000)
                .rows(3),
              LButton(LText(t('memberships.sendReport', 'Send report')))
                .disabled(!report.trim() || pending)
                .onPress(() => {
                  void action(async () => {
                    await membershipsService.report(content.id, report);
                    setReport(null);
                    setReported(true);
                  });
                }),
              LButton(LText(t('common.cancel', 'Cancel')))
                .style('plain')
                .onPress(() => setReport(null)),
            ).spacing('sm')
          : null,
        error ? RawText(error).foreground('destructive').role('alert') : null,
      )
        .padding('all', 'lg')
        .spacing('md'),
    ),
  );
}
