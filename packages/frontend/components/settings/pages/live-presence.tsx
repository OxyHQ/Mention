import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import type { BloomIcon } from '@/components/settings/RowIcon';
import {
  getLivePresencePreference,
  updateLivePresencePreference,
  type LiveVisibility,
} from '@/lib/syraApi';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Embed,
  SettingsSelect as LSettingsSelect,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface PresenceOption {
  value: LiveVisibility;
  labelKey: string;
  labelDefault: string;
  descKey: string;
  descDefault: string;
  icon: BloomIcon;
}

const OPTIONS: PresenceOption[] = [
  {
    value: 'active',
    labelKey: 'settings.livePresence.active',
    labelDefault: "When I'm in a live room",
    descKey: 'settings.livePresence.activeDesc',
    descDefault: 'Your avatar shows a live badge to others whenever you join a live room.',
    icon: RiBroadcastLine,
  },
  {
    value: 'speaking',
    labelKey: 'settings.livePresence.speaking',
    labelDefault: "Only when I'm speaking",
    descKey: 'settings.livePresence.speakingDesc',
    descDefault: 'Your avatar shows a live badge only while you hold the mic.',
    icon: RiMic2Line,
  },
];

export default function LivePresenceScreen() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const viewerId = user?.id;
  const livePresenceQueryKey = viewerQueryKeys.livePresence(viewerId);

  const { data: preference, isLoading } = useQuery({
    queryKey: livePresenceQueryKey,
    queryFn: getLivePresencePreference,
    enabled: canUsePrivateApi && Boolean(viewerId),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: updateLivePresencePreference,
    onMutate: async (next: LiveVisibility) => {
      await queryClient.cancelQueries({ queryKey: livePresenceQueryKey });
      const previous = queryClient.getQueryData<LiveVisibility>(livePresenceQueryKey);
      queryClient.setQueryData<LiveVisibility>(livePresenceQueryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context) {
        queryClient.setQueryData(livePresenceQueryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: livePresenceQueryKey });
    },
  });

  const selected: LiveVisibility = preference ?? 'active';

  if (isPrivateApiPending) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.livePresence.signInRequired', {
              defaultValue: 'Sign in to manage your live presence',
            })}
            description={t('settings.livePresence.signInRequiredDesc', {
              defaultValue: 'Choose when others see you live in a room.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  if (isLoading) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'presence',
          rows: [
            {
              key: 'visibility',
              label: t('settings.livePresence.title', {
                defaultValue: 'Live presence',
              }),
              description: t('settings.livePresence.footer', {
                defaultValue: 'This controls when your avatar shows a live badge across Mention.',
              }),
              control: toElement(
                LSettingsSelect(
                  t('settings.livePresence.title', {
                    defaultValue: 'Live presence',
                  }),
                  [
                    selected,
                    (value) => {
                      if (!mutation.isPending) mutation.mutate(value);
                    },
                  ],
                  OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey, {
                      defaultValue: option.labelDefault,
                    }),
                  })),
                ),
              ),
            },
          ],
        },
      ]}
    />
  );
}
