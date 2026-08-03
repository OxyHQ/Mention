import React from 'react';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxyhq/bloom/theme';
import { ThemedView } from '@/components/ThemedView';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { StatusBar } from 'expo-status-bar';
import { SEO } from '@/components/SEO';
import { InsightsView } from '@/components/insights/InsightsView';

/**
 * The VIEWER's own insights.
 *
 * The dashboard itself lives in {@link InsightsView}, which a channel's operators
 * render too at `/c/<handle>/insights`. This route is the difference between the
 * two: it names no subject, so every read is about the signed-in account.
 */
const InsightsScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const safeBack = useSafeBack();

    return (
        <>
            <SEO
                title={t('seo.insights.title')}
                description={t('seo.insights.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    <Header
                        options={{
                            title: t('Insights'),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />

                    <InsightsView />
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default InsightsScreen;
