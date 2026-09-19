import React from 'react';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import { CommunityNotesScreen } from '@/components/CommunityNotes/CommunityNotesScreen';
import { useCommunityNotesHub } from '@/hooks/useCommunityNotes';

/**
 * The community-notes hub. Every list comes from CrowdSource, which owns notes
 * and ratings; while it is answering — or in a deployment where it is not
 * configured at all — the screen renders its empty states.
 */
export default function CommunityNotesRoute() {
  const { t } = useTranslation();
  const { toRate, rated, written, handlers } = useCommunityNotesHub();
  return (
    <>
      <SEO title={t('communityNotes.hub.title', { defaultValue: 'Community notes' })} />
      <CommunityNotesScreen toRate={toRate} rated={rated} written={written} handlers={handlers} />
    </>
  );
}
