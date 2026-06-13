import React from 'react';
import { ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';

export default function HiddenWordsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.hiddenWords'),
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
                contentContainerClassName="py-2 flex-1"
                showsVerticalScrollIndicator={false}
            >
                <EmptyState
                    title={t('settings.privacy.hiddenWordsComingSoon')}
                    icon={{
                        name: 'eye-off-outline',
                        size: 48,
                    }}
                />
            </ScrollView>
        </ThemedView>
    );
}
