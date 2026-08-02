import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import type {
  FederationBlockCategory,
  FederationBlockSeverity,
  FederationBlocksResponse,
  PublishedFederationBlock,
} from '@mention/shared-types';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/Header';
import { ThemedView } from '@/components/ThemedView';
import { IconButton } from '@/components/ui/Button';
import { useSafeBack } from '@/hooks/useSafeBack';
import { publicApi } from '@/utils/api';

/**
 * Public moderation transparency: the instances Mention refuses to federate
 * with, and why.
 *
 * Unauthenticated on purpose — this is a statement to the outside world, and the
 * people most entitled to read it are the ones who are not here. It renders the
 * server's own `GET /federation/blocked-domains`, which is served from the same
 * array the federation policy derives its enforced set from, so the page cannot
 * describe a policy the server is not applying.
 */

const BLOCKED_DOMAINS_QUERY_KEY = ['federation', 'blocked-domains'] as const;

/** A paragraph of the explanatory copy. */
function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text className="mt-3 text-[15px] leading-6 text-muted-foreground">{children}</Text>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text className="mt-8 text-lg font-bold text-foreground">{children}</Text>;
}

function BlockCard({ block }: { block: PublishedFederationBlock }) {
  const { t } = useTranslation();

  /**
   * How far the decision goes. Read off the block rather than hard-coded, so a
   * severity the server starts publishing can never be shown under the wrong
   * label — the same reason `severity` is a union and not a boolean.
   */
  const severityLabel = (severity: FederationBlockSeverity): string => {
    switch (severity) {
      case 'suspend':
        return t('transparency.severity.suspend');
    }
  };

  /**
   * Public label per reason. A `switch` rather than a lookup table so every key
   * is a literal the i18n validator can see, and so adding a category to the
   * union fails to compile until it has copy.
   */
  const categoryLabel = (category: FederationBlockCategory): string => {
    switch (category) {
      case 'child_safety':
        return t('transparency.category.childSafety');
      case 'hate_speech':
        return t('transparency.category.hateSpeech');
      case 'harassment':
        return t('transparency.category.harassment');
      case 'spam':
        return t('transparency.category.spam');
      case 'malware':
        return t('transparency.category.malware');
      case 'unmoderated':
        return t('transparency.category.unmoderated');
    }
  };

  return (
    <View className="mt-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 text-base font-semibold text-foreground">{block.domain}</Text>
        <View className="rounded-full bg-secondary px-2.5 py-1">
          <Text className="text-xs font-medium text-secondary-foreground">
            {severityLabel(block.severity)}
          </Text>
        </View>
      </View>

      {block.source === 'policy' ? (
        <>
          <Text className="mt-2 text-[15px] leading-6 text-foreground">{block.reason}</Text>
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('transparency.blockMeta', {
              category: categoryLabel(block.category),
              since: block.since,
            })}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {block.corroboratingSources.length > 0
              ? t('transparency.corroboratedBy', {
                  sources: block.corroboratingSources.join(', '),
                })
              : t('transparency.decidedHere')}
          </Text>
        </>
      ) : (
        <Text className="mt-2 text-[15px] leading-6 text-muted-foreground">
          {t('transparency.operationalBlock')}
        </Text>
      )}
    </View>
  );
}

export default function TransparencyScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const blocksQuery = useQuery({
    queryKey: BLOCKED_DOMAINS_QUERY_KEY,
    queryFn: async () => {
      const response = await publicApi.get<FederationBlocksResponse>('/federation/blocked-domains');
      return response.data.blocks;
    },
    staleTime: 5 * 60 * 1000,
  });

  const blocks = blocksQuery.data;

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('transparency.title'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-2 pb-12"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-2xl font-bold text-foreground">{t('transparency.heading')}</Text>
        <Paragraph>{t('transparency.intro')}</Paragraph>
        <Paragraph>{t('transparency.introSource')}</Paragraph>

        <SectionTitle>{t('transparency.whatItDoes.title')}</SectionTitle>
        <Paragraph>{t('transparency.whatItDoes.body')}</Paragraph>
        <Paragraph>{t('transparency.whatItDoes.bluntness')}</Paragraph>
        <Paragraph>{t('transparency.whatItDoes.scope')}</Paragraph>
        <Paragraph>{t('transparency.whatItDoes.limits')}</Paragraph>

        <SectionTitle>{t('transparency.howWeDecide.title')}</SectionTitle>
        <Paragraph>{t('transparency.howWeDecide.corroboration')}</Paragraph>
        <Paragraph>{t('transparency.howWeDecide.judgement')}</Paragraph>
        <Paragraph>{t('transparency.howWeDecide.audit')}</Paragraph>

        <SectionTitle>{t('transparency.list.title')}</SectionTitle>

        {blocksQuery.isPending ? (
          <View className="items-center py-10">
            <Loading />
          </View>
        ) : blocksQuery.isError ? (
          <Paragraph>{t('transparency.list.error')}</Paragraph>
        ) : blocks && blocks.length > 0 ? (
          <>
            <Paragraph>{t('transparency.list.count', { count: blocks.length })}</Paragraph>
            {blocks.map((block) => (
              <BlockCard key={block.domain} block={block} />
            ))}
          </>
        ) : (
          <Paragraph>{t('transparency.list.empty')}</Paragraph>
        )}
      </ScrollView>
    </ThemedView>
  );
}
