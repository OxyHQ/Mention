import React from 'react';
import { ScrollView, Platform } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { useTranslation } from 'react-i18next';
import { useHapticsStore } from '@/stores/hapticsStore';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';

export default function AccessibilitySettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const hapticsDisabled = useHapticsStore((s) => s.disabled);
    const setHapticsDisabled = useHapticsStore((s) => s.setDisabled);

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.accessibility.title', { defaultValue: 'Accessibility' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-4 pb-8"
                showsVerticalScrollIndicator={false}
            >
                {/* Interaction */}
                {Platform.OS !== 'web' ? (
                    <SettingsGroup title={t('settings.accessibility.interaction', { defaultValue: 'Interaction' })}>
                        <SettingsItem
                            icon="hand-left"
                            title={t('settings.accessibility.hapticFeedback', { defaultValue: 'Haptic feedback' })}
                            description={t('settings.accessibility.hapticFeedbackDesc', { defaultValue: 'Vibration feedback on interactions' })}
                            showChevron={false}
                            rightElement={
                                <Toggle
                                    value={!hapticsDisabled}
                                    onValueChange={(enabled) => setHapticsDisabled(!enabled)}
                                />
                            }
                        />
                    </SettingsGroup>
                ) : null}

                {/* Media */}
                <SettingsGroup title={t('settings.accessibility.media', { defaultValue: 'Media' })}>
                    <SettingsItem
                        icon="text"
                        title={t('settings.accessibility.requireAltText', { defaultValue: 'Require alt text' })}
                        description={t('settings.accessibility.requireAltTextDesc', { defaultValue: 'Require alt text before posting images' })}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={false}
                                onValueChange={() => {}}
                            />
                        }
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
