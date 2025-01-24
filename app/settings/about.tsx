import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, SafeAreaView, TouchableOpacity, FlatList } from "react-native";
import { Post as PostType } from "@/interfaces/Post";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { Stack, Link } from "expo-router";
import { colors } from "@/styles/colors";
import { Header } from "@/components/Header";
import { toast } from '@/lib/sonner';
import Avatar from "@/components/Avatar";

interface SettingItemProps {
    icon: string;
    title: string;
    subtitle?: string;
    link?: string;
    onPress?: () => void;
    content?: string;
}

const SettingItem: React.FC<SettingItemProps> = ({ icon, title, subtitle, link, onPress, content }) => (
    <Link href={link as any} asChild>
        <TouchableOpacity style={styles.settingItem} onPress={onPress}>
            <View style={styles.iconContainer}>
                <Ionicons name={icon as any} size={24} color="#333" />
            </View>
            <View style={styles.textContainer}>
                <Text style={styles.title}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
            <Text style={styles.content}>{content}</Text>
        </TouchableOpacity>
    </Link>
);

export default function SettingsAboutScreen() {
    const { t } = useTranslation();

    return (
        <>
            <Stack.Screen options={{ title: t("Settings") }} />
            <SafeAreaView style={styles.container}>
                <Header options={{
                    leftComponents: [<Ionicons name="settings" size={24} color={colors.COLOR_BLACK} />],
                    title: t("Settings"),
                    rightComponents: [<Ionicons name="add" size={24} color={colors.COLOR_BLACK} onPress={() => toast('My first toast')} />],
                }} />
                <SettingItem
                    icon="document-text"
                    title={t('Terms of Service')}
                    link="/"
                />
                <SettingItem
                    icon="shield-checkmark"
                    title={t('Privacy Policy')}
                    link="/"
                />
                <SettingItem
                    icon="bug"
                    title={t('System log')}
                    link="/"
                />
                <SettingItem
                    icon="information-circle"
                    title={t('Version')}
                    subtitle={t('1.0.0')}
                    link="/"
                    content="1.0.0"
                />
            </SafeAreaView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: 16,
        padding: 8,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 35,
    },
    searchIcon: {
        marginHorizontal: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
        color: '#000',
        paddingVertical: 8,
    },
    scrollView: {
        flex: 1,
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    iconContainer: {
        width: 40,
        height: 40,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    textContainer: {
        flex: 1,
    },
    title: {
        fontSize: 16,
        fontWeight: '500',
        color: '#000',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 14,
        color: '#666',
    },
    content: {
        fontSize: 16,
        color: '#666',
        paddingEnd: 15,
    }
});