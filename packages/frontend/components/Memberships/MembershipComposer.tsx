import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateMembershipContentRequest, MembershipTier } from '@mention/shared-types';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';
import { pickedDocumentFile } from './pickedDocumentFile';

import {
  Button as LButton,
  Card as LCard,
  Embed,
  HStack,
  RawText,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function MembershipComposer({
  communityId,
  manager,
  parentContentId,
  tiers,
  onCreated,
}: {
  communityId: string;
  manager: boolean;
  parentContentId?: string;
  tiers: MembershipTier[];
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [requiredTierIds, setRequiredTierIds] = useState<string[]>([]);
  const [kind, setKind] = useState<CreateMembershipContentRequest['kind']>('discussion');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [teaser, setTeaser] = useState('');
  const [options, setOptions] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; mime: string; size: number }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const labels = {
    discussion: t('memberships.discussion', 'Discussion'),
    post: t('memberships.post', 'Post'),
    article: t('memberships.article', 'Article'),
    poll: t('memberships.poll', 'Poll'),
  };
  const pollOptions = options
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const publish = async () => {
    setPending(true);
    setError('');
    try {
      await membershipsService.createContent(communityId, {
        kind,
        ...(manager && !parentContentId ? { requiredTierIds } : {}),
        mediaIds: attachments.map((file) => file.id),
        body: body.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(manager && teaser.trim() && !parentContentId ? { teaser: teaser.trim() } : {}),
        ...(parentContentId ? { parentContentId } : {}),
        ...(kind === 'poll'
          ? {
              poll: { options: pollOptions, endsAt: new Date(Date.now() + 86400000).toISOString() },
            }
          : {}),
      });
      setAttachments([]);
      setBody('');
      setTitle('');
      setTeaser('');
      setOptions('');
      await onCreated();
    } catch (failure) {
      setError(
        getErrorMessage(failure, t('memberships.failed', 'The action could not be completed.')),
      );
    } finally {
      setPending(false);
    }
  };
  const attach = async () => {
    setPending(true);
    setError('');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'video/*', 'audio/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const file = pickedDocumentFile(asset);
      if (file.size > 40 * 1024 * 1024) {
        setError(t('memberships.fileTooLarge', 'Files must be 40 MB or smaller.'));
        return;
      }
      const media = await membershipsService.upload(
        communityId,
        await file.arrayBuffer(),
        asset.mimeType ?? file.type,
      );
      setAttachments((current) => [...current, media]);
    } catch (failure) {
      setError(
        getErrorMessage(
          failure,
          t('memberships.uploadFailed', 'The private file could not be uploaded.'),
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return toElement(
    LCard(
      VStack(
        RawText(
          parentContentId
            ? t('memberships.reply', 'Reply to this discussion')
            : t('memberships.write', 'Share with members'),
        )
          .weight('semibold')
          .foreground('foreground'),
        manager && !parentContentId
          ? HStack(
              (['discussion', 'post', 'article', 'poll'] as const).map((value) =>
                LButton(LText(labels[value]))
                  .size('sm')
                  .style(kind === value ? 'solid' : 'outline')
                  .onPress(() => setKind(value))
                  .id(value),
              ),
            )
              .wrap()
              .spacing('sm')
          : null,
        kind !== 'discussion'
          ? LTextField([title, setTitle], t('memberships.contentTitle', 'Title')).maxLength(200)
          : null,
        TextEditor([body, setBody])
          .label(t('memberships.body', 'Message for members'))
          .maxLength(50000)
          .rows(5),
        manager && !parentContentId
          ? TextEditor([teaser, setTeaser])
              .label(t('memberships.teaser', 'Optional public teaser'))
              .placeholder(t('memberships.teaser', 'Optional public teaser'))
              .maxLength(1000)
              .rows(2)
          : null,
        Embed(
          kind === 'poll' ? (
            <>
              {toElement(
                TextEditor([options, setOptions])
                  .label(t('memberships.pollOptions', 'One option per line (2–10)'))
                  .maxLength(2010)
                  .rows(4),
              )}
              {toElement(
                RawText(
                  t('memberships.pollDuration', 'Voting stays open for 24 hours.'),
                ).foreground('muted'),
              )}
            </>
          ) : null,
        ),
        manager && !parentContentId
          ? VStack(
              RawText(t('memberships.tiers', 'Membership tiers')).foreground('muted'),
              LButton(LText(t('explore.tabs.all')))
                .style(requiredTierIds.length === 0 ? 'solid' : 'outline')
                .onPress(() => setRequiredTierIds([])),
              tiers.map((tier) =>
                LButton(LText(tier.name))
                  .style(requiredTierIds.includes(tier.id) ? 'solid' : 'outline')
                  .onPress(() =>
                    setRequiredTierIds((current) =>
                      current.includes(tier.id)
                        ? current.filter((id) => id !== tier.id)
                        : [...current, tier.id],
                    ),
                  )
                  .id(tier.id),
              ),
            ).spacing('sm')
          : null,
        Embed(
          attachments.map((file, index) =>
            toElement(
              VStack(
                RawText(
                  t('memberships.attached', 'Private attachment {{number}} ready', {
                    number: index + 1,
                  }),
                ).foreground('muted'),
                LButton(LText(t('memberships.removeAction', 'Remove')))
                  .style('plain')
                  .disabled(pending)
                  .onPress(() => {
                    void (async () => {
                      setPending(true);
                      setError('');
                      try {
                        await membershipsService.discardUpload(communityId, file.id);
                        setAttachments((current) => current.filter((item) => item.id !== file.id));
                      } catch (failure) {
                        setError(
                          getErrorMessage(
                            failure,
                            t('memberships.failed', 'The action could not be completed.'),
                          ),
                        );
                      } finally {
                        setPending(false);
                      }
                    })();
                  }),
              ).spacing('sm'),
              file.id,
            ),
          ),
        ),
        LButton(LText(t('memberships.attach', 'Attach a private file')))
          .style('outline')
          .disabled(pending || attachments.length >= 10)
          .onPress(() => {
            void attach();
          }),
        error ? RawText(error).foreground('destructive').role('alert') : null,
        LButton(LText(t('memberships.publishContent', 'Publish to members')))
          .loading(pending)
          .disabled(
            !body.trim() ||
              (kind === 'poll' &&
                (pollOptions.length < 2 ||
                  pollOptions.length > 10 ||
                  pollOptions.some((value) => value.length > 200))),
          )
          .onPress(() => {
            void publish();
          }),
      )
        .padding('all', 'lg')
        .spacing('md'),
    ),
  );
}
