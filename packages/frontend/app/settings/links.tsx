import { useCallback, useState, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Platform, Animated } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { HeaderIconButton } from "@/components/HeaderIconButton";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { useTheme } from "@/hooks/useTheme";
import { useLinksStore } from "@/stores/linksStore";

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function LinkSettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const theme = useTheme();
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
        <ThemedView style={styles.container}>
            {/* Header */}
            <Header
                options={{
                    title: t("settings.links.title"),
                    leftComponents: [
                        <HeaderIconButton
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </HeaderIconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <Animated.ScrollView
                ref={assignScrollViewRef}
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as any}
            >
                {/* Clear All Cache Section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t("settings.links.cacheManagement")}
                    </Text>

                    <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <TouchableOpacity
                            style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem]}
                            onPress={handleClearAllCache}
                            disabled={isLoading}
                        >
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="trash" size={20} color={theme.colors.error} />
                                </View>
                                <View>
                                    <Text style={[styles.settingLabel, { color: theme.colors.error }]}>
                                        {t("settings.links.clearAllCache")}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t("settings.links.clearAllCacheDesc")}
                                    </Text>
                                </View>
                            </View>
                            {isLoading ? (
                                <IconComponent name="hourglass" size={16} color={theme.colors.textTertiary} />
                            ) : (
                                <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                            )}
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Refresh Single Link Section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t("settings.links.refreshLink")}
                    </Text>

                    <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <View style={[styles.settingItem, styles.firstSettingItem]}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="link" size={20} color={theme.colors.text} />
                                </View>
                                <View style={styles.inputContainer}>
                                    <TextInput
                                        style={[styles.input, { 
                                            color: theme.colors.text, 
                                            borderColor: theme.colors.border,
                                            backgroundColor: theme.colors.backgroundSecondary,
                                        }]}
                                        placeholder={t("settings.links.urlPlaceholder")}
                                        placeholderTextColor={theme.colors.textTertiary}
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

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        <TouchableOpacity
                            style={[styles.settingItem, styles.lastSettingItem]}
                            onPress={handleRefreshLink}
                            disabled={isLoading || !url.trim()}
                        >
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent 
                                        name="refresh" 
                                        size={20} 
                                        color={isLoading || !url.trim() ? theme.colors.textTertiary : theme.colors.primary} 
                                    />
                                </View>
                                <View>
                                    <Text style={[styles.settingLabel, { 
                                        color: isLoading || !url.trim() ? theme.colors.textTertiary : theme.colors.text 
                                    }]}>
                                        {t("settings.links.refreshLinkButton")}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t("settings.links.refreshLinkDesc")}
                                    </Text>
                                </View>
                            </View>
                            {isLoading ? (
                                <IconComponent name="hourglass" size={16} color={theme.colors.textTertiary} />
                            ) : (
                                <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.ScrollView>
        </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingBottom: 40,
    },
    section: {
        marginTop: 24,
        paddingHorizontal: 16,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 8,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    settingsCard: {
        borderRadius: 15,
        borderWidth: 1,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
    },
    firstSettingItem: {
        paddingTop: 16,
    },
    lastSettingItem: {
        paddingBottom: 16,
    },
    settingInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    settingIcon: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 4,
    },
    settingDescription: {
        fontSize: 13,
        lineHeight: 18,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        marginLeft: 44,
    },
    inputContainer: {
        flex: 1,
        marginLeft: 12,
    },
    input: {
        fontSize: 16,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1,
        minHeight: 44,
    },
});

