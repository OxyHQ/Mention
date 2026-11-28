import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search } from '@oxy.so/bloom/search';
import { Button } from '@oxy.so/bloom/button';
import { useAuth } from '@oxy.so/services/ui/client';
import { commerceService } from '@/services/commerceService';
import { useCommerceStorefront } from '@/hooks/useCommerceStorefront';

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
  return (
    <View className="p-4 gap-3">
      <Text className="text-foreground text-lg font-semibold">
        {t('commerce.shop', { defaultValue: 'Shop' })}
      </Text>
      <Text className="text-muted-foreground">
        {t('commerce.connectHelp', {
          defaultValue:
            'Connect a Mercaria store owned by this account. Products and checkout stay on Mercaria.',
        })}
      </Text>
      {store.data?.state === 'available' ? (
        <>
          <Text className="text-foreground">{store.data.store.name}</Text>
          <Button disabled={mutation.isPending} onPress={() => mutation.mutate('disconnect')}>
            {t('commerce.disconnect', { defaultValue: 'Disconnect store' })}
          </Button>
          {metrics.data ? (
            <Text className="text-muted-foreground">
              {metrics.data.suppressed
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
                  })}
            </Text>
          ) : null}
        </>
      ) : null}
      <Search
        label={t('commerce.storeHandle', { defaultValue: 'Mercaria store handle' })}
        value={handle}
        onChangeText={setHandle}
        onClearText={() => setHandle('')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button
        disabled={!handle.trim() || mutation.isPending}
        onPress={() => mutation.mutate('connect')}
      >
        {t('commerce.connect', { defaultValue: 'Connect store' })}
      </Button>
      {mutation.isError ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {t('commerce.connectError', {
            defaultValue:
              'Could not update the connection. Check the store handle and your access to this account.',
          })}
        </Text>
      ) : null}
      {store.isError ? (
        <Text className="text-muted-foreground">
          {t('commerce.shopUnavailable', { defaultValue: 'This shop is unavailable' })}
        </Text>
      ) : null}
    </View>
  );
}
