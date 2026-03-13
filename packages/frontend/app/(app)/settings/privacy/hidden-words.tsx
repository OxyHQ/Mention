import React from 'react';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';

export default function HiddenWordsScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.hiddenWords'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <EmptyState
                title={t('settings.privacy.hiddenWordsComingSoon')}
                icon={{
                    name: 'eye-off-outline',
                    size: 48,
                }}
            />
        </ThemedView>
    );
}
