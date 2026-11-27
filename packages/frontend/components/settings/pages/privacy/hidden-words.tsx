import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  isHashtagMuteWord,
  muteWordDisplayValue,
  muteWordsService,
  type SerializedMuteWord,
} from '@/services/muteWordsService';
import { invalidateSafetyFilters } from '@/stores/safetyInvalidation';
import { getErrorMessage } from '@/utils/apiError';

import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { confirm as confirmSettingsAction } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Admonition as LAdmonition,
  Button as LButton,
  Embed,
  Group,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  HStack,
  Icon,
  Loading,
  SettingsSection as LSettingsSection,
  Text,
  VStack,
  defineTokens,
  toElement,
  TextField,
} from '@oxy.so/bloom-language';

const hiddenWordsLogger = createLogger('HiddenWords');

/** The add button's glyph, a size Bloom's icon scale lacks. */
const appTokens = defineTokens({ iconSize: { add: 26 } });

export default function HiddenWordsScreen() {
  const { t } = useTranslation();

  const { isAuthenticated, user, canUsePrivateApi } = useAuth();

  const queryClient = useQueryClient();
  const [input, setInput] = useState('');

  const {
    data: mutedWords = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<SerializedMuteWord[]>({
    queryKey: viewerQueryKeys.muteWords(user?.id),
    queryFn: () => muteWordsService.list(),
    enabled: canUsePrivateApi,
  });

  const addMutation = useMutation<SerializedMuteWord, unknown, string>({
    mutationFn: (rawInput: string) => muteWordsService.create(rawInput),
    onSuccess: () => {
      setInput('');
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.muteWords(user?.id),
      });
      // Muting decides what the SERVER sends, so every surface holding
      // content fetched under the old rules is now wrong. One authority
      // tells both read caches: `stores/safetyInvalidation`.
      invalidateSafetyFilters();
      toast(t('settings.privacy.wordMuted', { defaultValue: 'Word muted' }), {
        type: 'success',
      });
    },
    onError: (error) => {
      hiddenWordsLogger.error('Failed to add muted word', error);
      toast(
        getErrorMessage(
          error,
          t('settings.privacy.failedToMuteWord', {
            defaultValue: 'Failed to mute word',
          }),
        ),
        {
          type: 'error',
        },
      );
    },
  });

  const removeMutation = useMutation<void, unknown, string>({
    mutationFn: (id: string) => muteWordsService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.muteWords(user?.id),
      });
      // Unmuting can only be honoured by asking again: the posts it lets
      // back in were never sent to this device.
      invalidateSafetyFilters();
      toast(t('settings.privacy.wordUnmuted', { defaultValue: 'Word unmuted' }), {
        type: 'success',
      });
    },
    onError: (error) => {
      hiddenWordsLogger.error('Failed to remove muted word', error);
      toast(
        getErrorMessage(
          error,
          t('settings.privacy.failedToUnmuteWord', {
            defaultValue: 'Failed to unmute word',
          }),
        ),
        { type: 'error' },
      );
    },
  });

  const handleAdd = () => {
    const value = input.trim();
    if (!value || addMutation.isPending) return;
    addMutation.mutate(value);
  };

  const handleRemove = (word: SerializedMuteWord) => {
    void confirmSettingsAction({
      title: t('settings.privacy.removeMutedWord', {
        defaultValue: 'Remove muted word',
      }),
      description: t('settings.privacy.removeMutedWordConfirm', {
        defaultValue: 'Stop hiding posts containing "{{value}}"?',
        value: muteWordDisplayValue(word),
      }),
      confirmLabel: t('common.remove', { defaultValue: 'Remove' }),
      cancelLabel: t('common.cancel'),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void (() => removeMutation.mutate(word.id))();
    });
  };

  if (!isAuthenticated) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.hiddenWordsSignInRequired', {
              defaultValue: 'Sign in to manage muted words',
            })}
            description={t('settings.privacy.hiddenWordsSignInRequiredDesc', {
              defaultValue: 'Muted words and hashtags hide matching posts from your feeds.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  return toElement(
    VStack(
      VStack(
        VStack(
          LAdmonition(
            Text(
              t('settings.privacy.hiddenWordsDescription', {
                defaultValue:
                  'Posts containing these words or hashtags are hidden from your feeds. Start an entry with # to mute a hashtag.',
              }),
            ),
          ).style('info'),
        ).margin('bottom', 'lg'),
        LSettingsSection(
          t('settings.privacy.addMutedWord', {
            defaultValue: 'Add a word or hashtag',
          }),
          LGroupedSection(
            HStack(
              Icon(RiEyeOffLine).size('md').foreground('muted'),
              TextField(
                [input, setInput],
                t('settings.privacy.addWordPlaceholder', {
                  defaultValue: 'Word or #hashtag',
                }),
              )
                .autocapitalize('none')
                .autocorrect(false)
                .placeholder(
                  t('settings.privacy.addWordPlaceholder', {
                    defaultValue: 'Word or #hashtag',
                  }),
                )
                .editable(!addMutation.isPending)
                .onSubmit(handleAdd)
                .submitLabel('done'),
              addMutation.isPending
                ? Loading().style('inline').size('sm')
                : LButton(
                    Group(
                      Icon(RiAddCircleLine)
                        .size(appTokens.iconSize.add)
                        .foreground(input.trim().length === 0 ? 'muted' : 'primary'),
                    ),
                  )
                    .size('sm')
                    .style('subtle')
                    .tint('neutral')
                    .onPress(handleAdd)
                    .disabled(input.trim().length === 0)
                    .label(
                      t('settings.privacy.addMutedWord', {
                        defaultValue: 'Add a word or hashtag',
                      }),
                    ),
            )
              .padding('horizontal', 'lg')
              .padding('vertical', 'md')
              .align('center')
              .spacing('md'),
          ),
        ),
        LSettingsSection(
          t('settings.privacy.mutedWords', {
            defaultValue: 'Muted words and hashtags',
          }),
          LGroupedSection(
            Embed(
              isLoading ? (
                <ListSkeleton />
              ) : isError ? (
                toElement(
                  VStack(
                    Embed(
                      <EmptyState
                        title={t('settings.privacy.failedToLoadMutedWords', {
                          defaultValue: 'Failed to load muted words',
                        })}
                        error={{
                          title: t('settings.privacy.failedToLoadMutedWords', {
                            defaultValue: 'Failed to load muted words',
                          }),
                          message: t('common.tryAgain', {
                            defaultValue: 'Try again',
                          }),
                          onRetry: async () => {
                            await refetch();
                          },
                        }}
                      />,
                    ),
                  ).padding('vertical', 'lg'),
                )
              ) : mutedWords.length === 0 ? (
                toElement(
                  VStack(
                    Embed(
                      <EmptyState
                        title={t('settings.privacy.mutedWordsEmpty', {
                          defaultValue: 'No muted words yet',
                        })}
                        sticker="mutedWords"
                      />,
                    ),
                  ).padding('vertical', 'lg'),
                )
              ) : (
                mutedWords.map((word) => {
                  const isHashtag = isHashtagMuteWord(word);
                  return toElement(
                    LGroupedSectionItem(muteWordDisplayValue(word))
                      .wrapControl()
                      .description(
                        isHashtag
                          ? t('settings.privacy.mutedWordTypeHashtag', {
                              defaultValue: 'Hashtag',
                            })
                          : t('settings.privacy.mutedWordTypeWord', {
                              defaultValue: 'Word',
                            }),
                      )
                      .trailing(
                        LButton(Text(t('common.remove', { defaultValue: 'Remove' })))
                          .size('sm')
                          .style('subtle')
                          .tint('danger')
                          .onPress(() => handleRemove(word))
                          .label(
                            t('settings.privacy.removeMutedWord', {
                              defaultValue: 'Remove muted word',
                            }),
                          ),
                      ),
                    word.id,
                  );
                })
              ),
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
