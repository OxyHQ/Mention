import React from 'react';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import { CommunityNotesScreen } from '@/components/CommunityNotes/CommunityNotesScreen';

/**
 * The community-notes hub. The lists come from CrowdSource, which owns notes
 * and ratings; until Mention's CrowdSource client serves them the hub renders
 * its empty states.
 */
export default function CommunityNotesRoute() {
  const { t } = useTranslation();
  return (
    <>
      <SEO title={t('communityNotes.hub.title', { defaultValue: 'Community notes' })} />
      <CommunityNotesScreen toRate={[]} rated={[]} written={[]} />
    </>
  );
}
