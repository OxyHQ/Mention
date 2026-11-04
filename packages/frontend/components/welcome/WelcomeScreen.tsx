import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Muted, Title } from '@oxy.so/bloom/typography';
import { WizardFooter, WizardProgress, type WizardStep } from '@oxy.so/bloom/wizard';
import { TopicPicker } from '@/components/interests/TopicPicker';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { LazyWhoToFollowTab } from '@/components/sharedRouteScreens';
import { useCompleteWelcome } from '@/hooks/useWelcome';
import { useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { WelcomeStarterPacks } from './WelcomeStarterPacks';

/**
 * Where to go once the flow is done: the in-app path the person was opening
 * when `WelcomeRedirectGate` sent them here, or home. Only an app-relative path
 * is honoured, so `next` can never send anyone off-site.
 */
function destination(next: string | undefined): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/**
 * `/welcome` — the first run for a new account: pick interests, follow some
 * people, set up the profile. Every step is optional, and finishing or skipping
 * is recorded once on the server, so the flow never comes back.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const complete = useCompleteWelcome();
  const [step, setStep] = useState(0);

  const steps: WizardStep[] = [
    {
      key: 'interests',
      title: t('welcome.interests.title'),
      description: t('welcome.interests.description'),
    },
    {
      key: 'people',
      title: t('welcome.people.title'),
      description: t('welcome.people.description'),
    },
    {
      key: 'profile',
      title: t('welcome.profile.title'),
      description: t('welcome.profile.description'),
    },
  ];
  const isLast = step === steps.length - 1;

  const finish = () => {
    complete.mutate(undefined, {
      onSettled: () => router.replace(destination(next)),
    });
  };

  return (
    <Screen
      header={
        <View className="px-4 pt-4">
          <WizardProgress
            steps={steps}
            current={step}
            formatStepCount={(position, total) => t('welcome.stepCount', { position, total })}
            action={
              <Button size="sm" appearance="subtle" tone="neutral" onPress={finish}>
                {t('welcome.skip')}
              </Button>
            }
          />
        </View>
      }
      bottomBar={
        <WizardFooter
          onBack={step > 0 ? () => setStep(step - 1) : undefined}
          backLabel={t('welcome.back')}
          onNext={isLast ? finish : () => setStep(step + 1)}
          nextLabel={isLast ? t('welcome.finish') : t('welcome.next')}
          loading={complete.isPending}
        />
      }
    >
      {step === 0 ? (
        <ScreenScrollView contentContainerClassName="pt-2">
          <TopicPicker query="" />
        </ScreenScrollView>
      ) : step === 1 ? (
        <LazyWhoToFollowTab listHeaderComponent={<WelcomeStarterPacks />} />
      ) : (
        <ScreenScrollView contentContainerClassName="gap-3 px-4 pt-4">
          <Title variant="headline-semibold">{t('welcome.profile.heading')}</Title>
          <Muted>{t('welcome.profile.body')}</Muted>
          <View className="flex-row">
            <Button onPress={() => requestSettings('/settings/edit-profile')}>
              {t('welcome.profile.edit')}
            </Button>
          </View>
        </ScreenScrollView>
      )}
    </Screen>
  );
}
