import React from 'react';
import { View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
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
            <View className="flex-1">
                <StatusBar style={theme.isDark ? "light" : "dark"} />

                <PageHeader
                    title={t('Insights')}
                    onBack={() => safeBack()}
                    backLabel={t('common.back', { defaultValue: 'Back' })}
                />

                <InsightsView />
            </View>
        </>
    );
};

export default InsightsScreen;
