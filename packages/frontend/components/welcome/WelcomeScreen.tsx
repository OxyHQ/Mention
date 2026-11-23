import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { CardBody, CardDescription, CardHeader } from '@oxy.so/bloom/card';

import { PageFooter } from '@oxy.so/bloom/page-footer';
import { WizardProgress, type WizardStep } from '@oxy.so/bloom/wizard';
import { TopicPicker } from '@/components/interests/TopicPicker';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { LazyWhoToFollowTab } from '@/components/sharedRouteScreens';
import { useCompleteWelcome } from '@/hooks/useWelcome';
import { useLocalSearchParams, useRouter, type Href } from '@/lib/navigation/router';
import { WelcomeStarterPacks } from './WelcomeStarterPacks';

import {
  Button as LButton,
  Embed,
  Header,
  ScrollView,
  Text,
  toElement,
  Embed as LEmbed,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';

/**
 * Where to go once the flow is done: the in-app path the person was opening
 * when `WelcomeRedirectGate` sent them here, or home. Only an app-relative path
 * is honoured, so `next` can never send anyone off-site.
 */
function destination(next: string | undefined): Href {
  return next?.startsWith('/') && !next.startsWith('//') ? (next as Href) : '/';
}

/** A step's heading: its title, and the line under it, in Bloom's card header. */
function StepHeading({ title, description }: { title: string; description?: string }) {
  return (
    <CardHeader>
      {toElement(Text(title).textStyle('title').font('display-3').weight('semibold'))}
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  );
}

/**
 * `/welcome` — the first run for a new account: pick interests, follow some
 * people, set up the profile. Every step is optional, and finishing or skipping
 * is recorded once on the server, so the flow never comes back.
 */
export const WelcomeScreen = screen(function WelcomeScreen() {
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

  const primaryAction = toElement(
    LButton(Text(isLast ? t('welcome.finish') : t('welcome.next')))
      .size('lg')
      .onPress(isLast ? finish : () => setStep(step + 1))
      .loading(complete.isPending),
  );

  return LEmbed(
    step === 0 ? (
      toElement(
        ScrollView(
          Embed(<StepHeading title={steps[0].title} description={steps[0].description} />),
          Embed(<TopicPicker query="" />),
        ),
      )
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
      toElement(
        ScrollView(
          Embed(<StepHeading title={steps[2].title} description={steps[2].description} />),
          Embed(
            <CardBody>
              {toElement(Text(t('welcome.profile.body')).textStyle('muted'))}
              {toElement(
                LButton(Text(t('welcome.profile.edit'))).onPress(() =>
                  requestSettings('/settings/edit-profile'),
                ),
              )}
            </CardBody>,
          ),
        ),
      )
    ),
  )
    .header(
      LEmbed(
        toElement(
          Header()
            .onBack(null)
            .toolbar(
              LButton(Text(t('welcome.skip')))
                .size('sm')
                .style('subtle')
                .tint('neutral')
                .onPress(finish),
            )
            .accessory(
              Embed(
                <WizardProgress
                  steps={steps}
                  current={step}
                  hideTitle
                  formatStepCount={(position, total) => t('welcome.stepCount', { position, total })}
                />,
              ),
            )
            .inPage(),
        ),
      ),
    )
    .footer(
      LEmbed(
        <PageFooter scrim="always" actions={primaryAction}>
          {/* Always present, so the primary action stays on the right on every step. */}
          <Button.Group separated>
            {step > 0
              ? toElement(LButton(Text(t('welcome.back'))).onPress(() => setStep(step - 1)))
              : null}
          </Button.Group>
        </PageFooter>,
      ),
      { placement: 'overlay' },
    );
});
