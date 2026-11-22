import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  FederationBlockCategory,
  FederationBlockSeverity,
  FederationBlocksResponse,
  PublishedFederationBlock,
} from '@mention/shared-types';
import { publicApi } from '@/utils/api';
import { EmptyState } from '@/components/common/EmptyState';
import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
const paragraph = (text: string) =>
  RawText(text).margin('top', 'md').font('md').leading('24px').foreground('muted');

const sectionTitle = (text: string) =>
  RawText(text)
    .margin('top', '3xl')
    .font('18')
    .leading('28px')
    .weight('bold')
    .foreground('foreground');

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

  return toElement(
    VStack(
      HStack(
        RawText(block.domain)
          .flex('1')
          .font('16')
          .leading('normal')
          .weight('semibold')
          .foreground('foreground'),
        VStack(
          RawText(severityLabel(block.severity))
            .font('xs')
            .leading('16px')
            .weight('medium')
            .foreground('muted'),
        )
          .padding('horizontal', '10')
          .padding('vertical', 'xs')
          .background('mutedFill')
          .corner('infinite'),
      )
        .align('start')
        .justify('between')
        .spacing('md'),
      Embed(
        block.source === 'policy' ? (
          <>
            {toElement(
              RawText(block.reason)
                .margin('top', 'sm')
                .font('md')
                .leading('24px')
                .foreground('foreground'),
            )}
            {toElement(
              RawText(
                t('transparency.blockMeta', {
                  category: categoryLabel(block.category),
                  since: block.since,
                }),
              )
                .margin('top', 'md')
                .font('xs')
                .leading('16px')
                .foreground('muted'),
            )}
            {toElement(
              RawText(
                block.corroboratingSources.length > 0
                  ? t('transparency.corroboratedBy', {
                      sources: block.corroboratingSources.join(', '),
                    })
                  : t('transparency.decidedHere'),
              )
                .margin('top', 'xs')
                .font('xs')
                .leading('16px')
                .foreground('muted'),
            )}
          </>
        ) : (
          toElement(
            RawText(t('transparency.operationalBlock'))
              .margin('top', 'sm')
              .font('md')
              .leading('24px')
              .foreground('muted'),
          )
        ),
      ),
    )
      .padding('all', 'lg')
      .background('card')
      .border('border', 'thin')
      .corner('lg')
      .margin('top', 'md'),
  );
}

export default function TransparencySettingsPage() {
  const { t } = useTranslation();

  const blocksQuery = useQuery({
    queryKey: BLOCKED_DOMAINS_QUERY_KEY,
    queryFn: async () => {
      const response = await publicApi.get<FederationBlocksResponse>('/federation/blocked-domains');
      return response.data.blocks;
    },
    staleTime: 5 * 60 * 1000,
  });

  const blocks = blocksQuery.data;

  return toElement(
    VStack(
      RawText(t('transparency.heading'))
        .font('24')
        .leading('32px')
        .weight('bold')
        .foreground('foreground'),
      paragraph(t('transparency.intro')),
      paragraph(t('transparency.introSource')),
      sectionTitle(t('transparency.whatItDoes.title')),
      paragraph(t('transparency.whatItDoes.body')),
      paragraph(t('transparency.whatItDoes.bluntness')),
      paragraph(t('transparency.whatItDoes.scope')),
      paragraph(t('transparency.whatItDoes.limits')),
      sectionTitle(t('transparency.howWeDecide.title')),
      paragraph(t('transparency.howWeDecide.corroboration')),
      paragraph(t('transparency.howWeDecide.judgement')),
      paragraph(t('transparency.howWeDecide.audit')),
      sectionTitle(t('transparency.list.title')),
      Embed(
        blocksQuery.isPending ? (
          <ListSkeleton />
        ) : blocksQuery.isError ? (
          toElement(paragraph(t('transparency.list.error')))
        ) : blocks && blocks.length > 0 ? (
          <>
            {toElement(paragraph(t('transparency.list.count', { count: blocks.length })))}
            {blocks.map((block) => (
              <BlockCard key={block.domain} block={block} />
            ))}
          </>
        ) : (
          <EmptyState
            title={t('transparency.list.empty')}
            sticker="transparency"
            containerStyle={{ paddingTop: 40 }}
          />
        ),
      ),
    ),
  );
}
