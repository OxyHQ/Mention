import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { View } from 'react-native';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';

import { LinkifiedText } from '@/components/common/LinkifiedText';
import { SEO } from '@/components/SEO';
import { feedService } from '@/services/feedService';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';
import { useStorePost } from '@/hooks/useStorePost';
import { formatFullTimestamp } from '@/utils/dateUtils';
import { EmptyState } from '@/components/common/EmptyState';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles((t) => ({
  intro: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 4,
    color: t.mutedForeground,
  },
  errorText: { fontSize: 14, lineHeight: 20, textAlign: 'center', color: t.mutedForeground },
  truncated: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 12, color: t.mutedForeground },
  versionTitle: { fontSize: 15, fontWeight: '600' },
  versionSubtitle: { fontSize: 13, color: t.mutedForeground },
}));

/**
 * A post's public correction trail (route `/p/<id>/corrections`).
 *
 * A channel is a publication, so its posts stay editable for their whole life
 * instead of for the 30 minutes a personal post gets. This screen is the other
 * half of that bargain: every version the post has had, oldest first, ending
 * with what it says now — so "corrected" is something a reader can check rather
 * than something they are told.
 *
 * There is no author on a version, deliberately. A channel's writer is disclosed
 * only when the channel opts in, and a correction is made by exactly such a
 * writer, so naming one here would route around that setting.
 */
export default function PostCorrectionsScreen() {
  const textStyles = useTextStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const postId = String(id);
  const { t } = useTranslation();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: publicQueryKeys.postCorrections(postId),
    queryFn: () => feedService.getPostCorrections(postId),
    enabled: Boolean(postId),
  });

  // The live post supplies the newest version from the shared post store: an
  // edit made in the composer writes the updated post straight back there
  // (`cachePosts`), so arriving here from a correction shows the text that was
  // just saved. A link opened cold loads the post into the same store.
  const post = useStorePost(postId);
  const currentText = post?.content?.text ?? '';

  const corrections = data?.corrections ?? [];
  // `total` counts corrections MADE and never goes down; retention bounds how
  // many superseded bodies are still readable. The difference is versions this
  // screen cannot show, and saying so is the honest alternative to a trail that
  // silently skips revision numbers.
  const droppedVersions = Math.max((data?.total ?? 0) - corrections.length, 0);
  const title = t('post.corrections.title', { defaultValue: 'Correction history' });

  return (
    <>
      <SEO
        title={title}
        description={t('post.corrections.description', {
          defaultValue: 'Every version of this post on Mention',
        })}
      />
      <Screen
        header={<PageHeader title={title} backLabel={t('common.back', { defaultValue: 'Back' })} />}
      >
        <ScreenScrollView contentView contentContainerStyle={{ paddingBottom: 64 }}>
          <Text style={textStyles.intro}>
            {t('post.corrections.intro', {
              defaultValue:
                'This post has been changed since it was published. Every version it has had is listed here, oldest first.',
            })}
          </Text>

          {isLoading ? (
            <ListSkeleton />
          ) : isError ? (
            // An unreachable trail must not render as an empty one: "no
            // corrections" over an outage would say the post was never
            // changed, which is the opposite of what the marker promised.
            <View className="items-center gap-3 px-4 py-10">
              <Text style={textStyles.errorText}>
                {t('post.corrections.error', {
                  defaultValue: "Couldn't load this post's correction history.",
                })}
              </Text>
              <Button onPress={() => void refetch()}>
                {t('post.corrections.retry', { defaultValue: 'Try again' })}
              </Button>
            </View>
          ) : corrections.length === 0 ? (
            <EmptyState
              title={t('post.corrections.empty', {
                defaultValue: 'This post has not been corrected.',
              })}
              sticker="postCorrections"
              containerStyle={{ paddingTop: 40 }}
            />
          ) : (
            <>
              {droppedVersions > 0 ? (
                <Text style={textStyles.truncated}>
                  {t('post.corrections.truncated', {
                    count: droppedVersions,
                    defaultValue:
                      '{{count}} versions in between are no longer kept. The version numbers below skip them.',
                  })}
                </Text>
              ) : null}

              {corrections.map((correction) => (
                <Version
                  key={correction.revision}
                  title={
                    // Revision 1 is the body the post was
                    // PUBLISHED with, and it is exempt from
                    // retention eviction, so this is the one
                    // label the trail can always say plainly.
                    correction.revision === 1
                      ? t('post.corrections.originalVersion', {
                          defaultValue: 'As first published',
                        })
                      : t('post.corrections.version', {
                          revision: correction.revision,
                          defaultValue: 'Version {{revision}}',
                        })
                  }
                  // `correctedAt` is when this body was REPLACED,
                  // not when it was written, so the date reads
                  // "Replaced …" — labelling it as the version's
                  // own date would tell the reader the post said
                  // this FROM then on, which is backwards.
                  subtitle={t('post.corrections.replaced', {
                    timestamp: formatFullTimestamp(correction.correctedAt),
                    defaultValue: 'Replaced {{timestamp}}',
                  })}
                  text={correction.previousText}
                />
              ))}

              {currentText ? (
                <Version
                  title={t('post.corrections.currentVersion', {
                    defaultValue: 'Current version',
                  })}
                  subtitle={t('post.corrections.since', {
                    timestamp: formatFullTimestamp(corrections[corrections.length - 1].correctedAt),
                    defaultValue: 'Since {{timestamp}}',
                  })}
                  text={currentText}
                />
              ) : null}
            </>
          )}
        </ScreenScrollView>
      </Screen>
    </>
  );
}

/** One entry in the trail: what it was called, when, and what it said. */
function Version({ title, subtitle, text }: { title: string; subtitle: string; text: string }) {
  const textStyles = useTextStyles();
  return (
    <View className="border-border border-t px-4 py-4">
      <Text style={textStyles.versionTitle}>{title}</Text>
      <Text style={textStyles.versionSubtitle}>{subtitle}</Text>
      <LinkifiedText text={text} className="text-foreground mt-2 text-[15px]" />
    </View>
  );
}
