import { useCallback, useState } from "react";
import { View, Text, TextInput, ScrollView } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTranslation } from "react-i18next";
import { authenticatedClient } from "@/utils/api";
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { useTheme } from "@/hooks/useTheme";
import { useLinksStore } from "@/stores/linksStore";
import { SettingsItem, SettingsGroup } from "@/components/settings/SettingsItem";

export default function LinkSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    const { clearAll } = useLinksStore();

    const [url, setUrl] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleClearAllCache = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.links.clearAllCache'),
            message: t('settings.links.clearAllCacheMessage'),
            okText: t('common.clear'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;

        setIsLoading(true);
        try {
            clearAll();
            await authenticatedClient.post('/links/clear-cache');
            await alertDialog({
                title: t('common.success'),
                message: t('settings.links.clearAllCacheSuccess')
            });
        } catch (error: unknown) {
            console.error('Error clearing cache:', error);
            const axiosError = error as { response?: { status?: number } };
            const errorMessage = axiosError?.response?.status === 429
                ? t('settings.links.rateLimitExceeded')
                : t('settings.links.clearAllCacheError');
            await alertDialog({
                title: t('common.error'),
                message: errorMessage
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleRefreshLink = async () => {
        if (!url || !url.trim()) {
            await alertDialog({
                title: t('common.error'),
                message: t('settings.links.urlRequired'),
            });
            return;
        }

        try {
            new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
        } catch {
            await alertDialog({
                title: t('common.error'),
                message: t('settings.links.invalidUrl'),
            });
            return;
        }

        setIsLoading(true);
        try {
            const normalizedUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
            await authenticatedClient.post('/links/refresh', { url: normalizedUrl });

            const { invalidate } = useLinksStore.getState();
            invalidate(normalizedUrl);

            await alertDialog({
                title: t('common.success'),
                message: t('settings.links.refreshLinkSuccess')
            });

            setUrl('');
        } catch (error: unknown) {
            console.error('Error refreshing link:', error);
            const axiosError = error as { response?: { status?: number } };
            const errorMessage = axiosError?.response?.status === 429
                ? t('settings.links.rateLimitExceeded')
                : t('settings.links.refreshLinkError');
            await alertDialog({
                title: t('common.error'),
                message: errorMessage
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t("settings.links.title"),
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
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsGroup title={t("settings.links.cacheManagement")}>
                    <SettingsItem
                        icon="trash"
                        title={t("settings.links.clearAllCache")}
                        description={t("settings.links.clearAllCacheDesc")}
                        onPress={handleClearAllCache}
                        destructive
                    />
                </SettingsGroup>

                <SettingsGroup title={t("settings.links.refreshLink")}>
                    <View className="px-5 py-3">
                        <TextInput
                            className="text-base px-3 py-2.5 rounded-lg border border-border bg-secondary text-foreground"
                            style={{ minHeight: 44 }}
                            placeholder={t("settings.links.urlPlaceholder")}
                            placeholderTextColor={colors.textTertiary}
                            value={url}
                            onChangeText={setUrl}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            editable={!isLoading}
                        />
                    </View>
                    <SettingsItem
                        icon="refresh"
                        title={t("settings.links.refreshLinkButton")}
                        description={t("settings.links.refreshLinkDesc")}
                        onPress={handleRefreshLink}
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
