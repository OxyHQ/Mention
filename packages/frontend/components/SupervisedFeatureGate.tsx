// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useSupervisionState } from '@/hooks/useSupervisionState';

/** Unreviewed product surfaces are unavailable, not a request to weaken protection. */
export function SupervisedFeatureGate({
  children,
  allowSupervised = false,
}: {
  children: ReactNode;
  /** Only for a reviewed surface; this never replaces the live server decision. */
  allowSupervised?: boolean;
}) {
  const { t } = useTranslation();
  const state = useSupervisionState();
  if (state.isError)
    return (
      <EmptyState
        error={{
          title: t('safety.checkFailed'),
          message: t('safety.retryDescription'),
          onRetry: async () => {
            await state.refetch();
          },
        }}
      />
    );
  if (!state.ready) return <DetailSkeleton />;
  if (state.supervised && !allowSupervised)
    return (
      <EmptyState
        icon={RiLockLine}
        title={t('safety.unavailableTitle')}
        subtitle={t('safety.unavailableDescription')}
      />
    );
  return children;
}
