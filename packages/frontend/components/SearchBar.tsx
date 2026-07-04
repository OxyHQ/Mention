import { useRouter } from 'expo-router'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Search } from '@/assets/icons/search-icon'
import { SPACING } from '@/styles/spacing'
import { FONT_SIZES } from '@/styles/typography'
import { asViewStyle, type WebViewStyle } from '@/types/webStyles'

export const SearchBar = () => {
    const router = useRouter();
    const { t } = useTranslation();

    return (
        <View className="bg-background" style={styles.container}>
            <TouchableOpacity
                className="bg-muted"
                style={styles.searchInputContainer}
                onPress={() => router.push('/search')}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('Search Mention')}
            >
                <View style={styles.searchIconWrapper}>
                    <Search size={18} className="text-muted-foreground" />
                </View>
                <Text className="text-muted-foreground" style={styles.label} numberOfLines={1}>
                    {t('Search Mention')}
                </Text>
            </TouchableOpacity>
        </View>
    );
};

// `position: 'sticky'` and `cursor` are valid react-native-web values absent from
// RN's native style unions — author them through the shared extended ViewStyle
// (same pattern as SideBar/RightBar), then bridge to ViewStyle for StyleSheet
// rather than an `as any` cast.
const webStickyStyle: WebViewStyle = { position: 'sticky' };

const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        ...(Platform.OS === 'web' ? asViewStyle(webStickyStyle) : null),
        top: 0,
        zIndex: 1000,
        width: '100%',
    },
    searchInputContainer: {
        borderRadius: 100,
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.md,
        width: '100%',
        ...(Platform.OS === 'web' ? asViewStyle({ cursor: 'pointer' }) : null),
    },
    searchIconWrapper: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        fontSize: FONT_SIZES.lg,
        marginHorizontal: SPACING.md,
        flex: 1,
    },
});
