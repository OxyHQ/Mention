import React, { useContext, useEffect } from "react";
import { View, Text, StyleSheet, SafeAreaView, Button } from "react-native";
import { useTranslation } from "react-i18next";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useRouter } from "expo-router";

export default function AccountSettings() {
    const { t } = useTranslation();
    const { logoutUser, getCurrentUser } = useContext(SessionContext);
    const currentUser = getCurrentUser();
    const router = useRouter();

    const handleLogout = () => {
        logoutUser();
        router.push('/login');
    };

    return (
        <SafeAreaView style={styles.container}>
            <Text style={styles.title}>{t("Account Settings")}</Text>
            {currentUser && (
                <View>
                    <Text>{t("Name")}: {currentUser.name?.first} {currentUser.name?.last || ''}</Text>
                    <Text>{t("Username")}: {currentUser.username}</Text>
                    <Text>{t("Avatar")}: {currentUser.avatar}</Text>
                </View>
            )}
            <Button title={t("Logout")} onPress={handleLogout} />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: '#fff',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 16,
    },
});
