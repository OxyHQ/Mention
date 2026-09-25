import React from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { LogoIcon } from '@/assets/logo';
import { useNavigateOrReselect } from '@/hooks/useNavigateOrReselect';

export function MentionHomeHeader() {
  const router = useRouter();
  const { t } = useTranslation();
  const navigateOrReselect = useNavigateOrReselect();
  return <PageHeader
    title={<Pressable onPress={() => navigateOrReselect('/')} accessibilityRole="button" accessibilityLabel="Mention" hitSlop={8}>
      <LogoIcon size={28} className="text-foreground" />
    </Pressable>}
    titleAlign="center"
    presentation="floating"
    leading={<AppShellMenuButton />}
    actions={<ButtonGroup accessibilityLabel={t('common.actions', { defaultValue: 'Page actions' })}>
      <ButtonGroupItem iconOnly leadingIcon={RiSearchLine} accessibilityLabel={t('Search')} onPress={() => router.push('/search')} />
      <ButtonGroupItem iconOnly leadingIcon={RiNotification3Line} accessibilityLabel={t('Notifications')} onPress={() => router.push('/notifications')} />
    </ButtonGroup>}
  />;
}
