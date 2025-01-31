import React from "react";
import { View, Text, StyleSheet, SafeAreaView } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";

export default function NotificationSettings() {
    const { t } = useTranslation();

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{ title: `${t("Notifications")}` }} />
            <View style={styles.container}>

            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
});
