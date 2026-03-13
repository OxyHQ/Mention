import { useCallback, useState, useRef } from "react";
import { View, Text, TouchableOpacity, TextInput, Platform, Animated, StyleSheet } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { useTheme } from "@/hooks/useTheme";
import { useLinksStore } from "@/stores/linksStore";
import { cn } from "@/lib/utils";
import { ScrollView } from "react-native";

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function LinkSettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { colors } = useTheme();
    const scrollViewRef = useRef<ScrollView>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable } = useLayoutScroll();
    const { clearAll } = useLinksStore();

    const [url, setUrl] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const clearScrollRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignScrollViewRef = useCallback((node: any) => {
        scrollViewRef.current = node;
        clearScrollRegistration();
        if (node && registerScrollable) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollRegistration, registerScrollable]);

    const onScroll = useCallback(
        (event: any) => {
            handleScroll(event);
        },
        [handleScroll]
    );

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
            // Clear frontend cache
            clearAll();

            // Clear backend cache
            await authenticatedClient.post('/links/clear-cache');

            await alertDialog({
                title: t('common.success'),
                message: t('settings.links.clearAllCacheSuccess')
            });
        } catch (error: any) {
            console.error('Error clearing cache:', error);
            const errorMessage = error?.response?.status === 429
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

        // Validate URL format
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

            // Force refresh on backend (clears cache and re-fetches)
            await authenticatedClient.post('/links/refresh', { url: normalizedUrl });

            // Clear frontend cache for this URL
            const { invalidate } = useLinksStore.getState();
            invalidate(normalizedUrl);

            await alertDialog({
                title: t('common.success'),
                message: t('settings.links.refreshLinkSuccess')
            });

            // Clear input
            setUrl('');
        } catch (error: any) {
            console.error('Error refreshing link:', error);
            const errorMessage = error?.response?.status === 429
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
            {/* Header */}
            <Header
                options={{
                    title: t("settings.links.title"),
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

            <Animated.ScrollView
                ref={assignScrollViewRef}
                className="flex-1"
                contentContainerStyle={{ paddingBottom: 40 }}
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as any}
            >
                {/* Clear All Cache Section */}
                <View className="mt-6 px-4">
                    <Text className="text-[13px] font-semibold mb-2 uppercase tracking-wide text-foreground">
                        {t("settings.links.cacheManagement")}
                    </Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="flex-row items-center justify-between p-4"
                            onPress={handleClearAllCache}
                            disabled={isLoading}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="w-8 h-8 rounded-full items-center justify-center mr-3">
                                    <IconComponent name="trash" size={20} color={colors.error} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-1 text-destructive">
                                        {t("settings.links.clearAllCache")}
                                    </Text>
                                    <Text className="text-[13px] leading-[18px] text-muted-foreground">
                                        {t("settings.links.clearAllCacheDesc")}
                                    </Text>
                                </View>
                            </View>
                            {isLoading ? (
                                <IconComponent name="hourglass" size={16} color={colors.textTertiary} />
                            ) : (
                                <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                            )}
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Refresh Single Link Section */}
                <View className="mt-6 px-4">
                    <Text className="text-[13px] font-semibold mb-2 uppercase tracking-wide text-foreground">
                        {t("settings.links.refreshLink")}
                    </Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <View className="flex-row items-center p-4">
                            <View className="flex-row items-center flex-1">
                                <View className="w-8 h-8 rounded-full items-center justify-center mr-3">
                                    <IconComponent name="link" size={20} color={colors.text} />
                                </View>
                                <View className="flex-1 ml-3">
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
                            </View>
                        </View>

                        <View style={{ height: StyleSheet.hairlineWidth, marginLeft: 44 }} className="bg-border" />

                        <TouchableOpacity
                            className="flex-row items-center justify-between p-4"
                            onPress={handleRefreshLink}
                            disabled={isLoading || !url.trim()}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="w-8 h-8 rounded-full items-center justify-center mr-3">
                                    <IconComponent
                                        name="refresh"
                                        size={20}
                                        color={isLoading || !url.trim() ? colors.textTertiary : colors.primary}
                                    />
                                </View>
                                <View>
                                    <Text className={cn(
                                        "text-base font-medium mb-1",
                                        isLoading || !url.trim() ? "text-muted-foreground" : "text-foreground"
                                    )}>
                                        {t("settings.links.refreshLinkButton")}
                                    </Text>
                                    <Text className="text-[13px] leading-[18px] text-muted-foreground">
                                        {t("settings.links.refreshLinkDesc")}
                                    </Text>
                                </View>
                            </View>
                            {isLoading ? (
                                <IconComponent name="hourglass" size={16} color={colors.textTertiary} />
                            ) : (
                                <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.ScrollView>
        </ThemedView>
    );
}
