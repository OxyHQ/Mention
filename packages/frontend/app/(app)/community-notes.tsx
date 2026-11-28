// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
