import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { CardBody, CardDescription, CardHeader } from '@oxy.so/bloom/card';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { PageFooter } from '@oxy.so/bloom/page-footer';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Muted, Title } from '@oxy.so/bloom/typography';
import { WizardProgress, type WizardStep } from '@oxy.so/bloom/wizard';
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

/** A step's heading: its title, and the line under it, in Bloom's card header. */
function StepHeading({ title, description }: { title: string; description?: string }) {
  return (
    <CardHeader>
      <Title variant="display-3-semibold">{title}</Title>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  );
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

  const primaryAction = (
    <Button
      size="lg"
      onPress={isLast ? finish : () => setStep(step + 1)}
      loading={complete.isPending}
    >
      {isLast ? t('welcome.finish') : t('welcome.next')}
    </Button>
  );

  return (
    <Screen
      // Content passes under the floating header and footer, as in Bloom's own
      // floating chrome, instead of stopping at a bar.
      bottomBarPlacement="overlay"
      header={
        <PageHeader
          onBack={null}
          actions={
            <Button size="sm" appearance="subtle" tone="neutral" onPress={finish}>
              {t('welcome.skip')}
            </Button>
          }
          accessory={
            <WizardProgress
              steps={steps}
              current={step}
              hideTitle
              formatStepCount={(position, total) => t('welcome.stepCount', { position, total })}
            />
          }
        />
      }
      bottomBar={
        <PageFooter scrim="always" actions={primaryAction}>
          {/* Always present, so the primary action stays on the right on every step. */}
          <ButtonGroup separated>
            {step > 0 ? (
              <ButtonGroupItem onPress={() => setStep(step - 1)}>
                {t('welcome.back')}
              </ButtonGroupItem>
            ) : null}
          </ButtonGroup>
        </PageFooter>
      }
    >
      {step === 0 ? (
        <ScreenScrollView>
          <StepHeading title={steps[0].title} description={steps[0].description} />
          <TopicPicker query="" />
        </ScreenScrollView>
      ) : step === 1 ? (
        <LazyWhoToFollowTab
          showInviteBanner={false}
          listHeaderComponent={
            <>
              <StepHeading title={steps[1].title} description={steps[1].description} />
              <WelcomeStarterPacks />
            </>
          }
        />
      ) : (
        <ScreenScrollView>
          <StepHeading title={steps[2].title} description={steps[2].description} />
          <CardBody>
            <Muted>{t('welcome.profile.body')}</Muted>
            <Button onPress={() => requestSettings('/settings/edit-profile')}>
              {t('welcome.profile.edit')}
            </Button>
          </CardBody>
        </ScreenScrollView>
      )}
    </Screen>
  );
}
