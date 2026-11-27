import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { commerceService } from '@/services/commerceService';
import { useCommerceStorefront } from '@/hooks/useCommerceStorefront';

import {
  Button as LButton,
  Embed,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Search as LSearch } from '@oxy.so/bloom-language/inputs';

export function StorefrontSettings({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const client = useQueryClient();
  const [handle, setHandle] = useState('');
  const store = useCommerceStorefront(accountId);
  const available = store.data?.state === 'available';
  const metrics = useQuery({
    queryKey: viewerQueryKeys.commerceMetrics(user?.id, 'stores', accountId),
    queryFn: () => commerceService.metrics('stores', accountId),
    enabled: available,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: async (action: 'connect' | 'disconnect') => {
      if (action === 'connect') await commerceService.connect(accountId, handle.trim());
      else await commerceService.disconnect(accountId);
    },
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: viewerQueryKeys.commerceStorefront(user?.id, accountId),
      });
      await client.invalidateQueries({
        queryKey: viewerQueryKeys.commerceMetrics(user?.id, 'stores', accountId),
      });
    },
  });
  return toElement(
    VStack(
      RawText(t('commerce.shop', { defaultValue: 'Shop' }))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('semibold'),
      RawText(
        t('commerce.connectHelp', {
          defaultValue:
            'Connect a Mercaria store owned by this account. Products and checkout stay on Mercaria.',
        }),
      ).foreground('muted'),
      Embed(
        store.data?.state === 'available' ? (
          <>
            {toElement(RawText(store.data.store.name).foreground('foreground'))}
            {toElement(
              LButton(LText(t('commerce.disconnect', { defaultValue: 'Disconnect store' })))
                .disabled(mutation.isPending)
                .onPress(() => mutation.mutate('disconnect')),
            )}
            {metrics.data
              ? toElement(
                  RawText(
                    metrics.data.suppressed
                      ? t('commerce.metricsSuppressed', {
                          defaultValue:
                            'Activity totals appear after at least {{count}} opens in the last 30 days.',
                          count: metrics.data.minimumOpens,
                        })
                      : t('commerce.metricsSummary', {
                          defaultValue:
                            'Last 30 days: {{opens}} opens · {{handoffs}} visits to Mercaria. Counts are interactions, not unique visitors or sales.',
                          opens: metrics.data.opens,
                          handoffs: metrics.data.handoffs,
                        }),
                  ).foreground('muted'),
                )
              : null}
          </>
        ) : null,
      ),
      LSearch([handle, setHandle])
        .label(t('commerce.storeHandle', { defaultValue: 'Mercaria store handle' }))
        .onClearText(() => setHandle(''))
        .autocapitalize('none')
        .autocorrect(false),
      LButton(LText(t('commerce.connect', { defaultValue: 'Connect store' })))
        .disabled(!handle.trim() || mutation.isPending)
        .onPress(() => mutation.mutate('connect')),
      mutation.isError
        ? RawText(
            t('commerce.connectError', {
              defaultValue:
                'Could not update the connection. Check the store handle and your access to this account.',
            }),
          )
            .foreground('destructive')
            .role('alert')
        : null,
      store.isError
        ? RawText(
            t('commerce.shopUnavailable', { defaultValue: 'This shop is unavailable' }),
          ).foreground('muted')
        : null,
    )
      .padding('all', 'lg')
      .spacing('md'),
  );
}
