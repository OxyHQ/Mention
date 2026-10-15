import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxy.so/bloom/loading';
import { EmptyState } from '@/components/common/EmptyState';
import { useSupervisionState } from '@/hooks/useSupervisionState';

/** Unreviewed product surfaces are unavailable, not a request to weaken protection. */
export function SupervisedFeatureGate({ children }: { children: ReactNode }) {
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
  if (!state.ready) return <Loading />;
  if (state.supervised)
    return (
      <EmptyState
        icon={{ name: 'lock-closed-outline' }}
        title={t('safety.unavailableTitle')}
        subtitle={t('safety.unavailableDescription')}
      />
    );
  return children;
}
