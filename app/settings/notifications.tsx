import React, { useState } from "react";
import { View, Text, StyleSheet, SafeAreaView, Switch } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";

export default function NotificationSettings() {
    const { t } = useTranslation();
    const [pushEnabled, setPushEnabled] = useState(true);
    const [likesNotif, setLikesNotif] = useState(true);
    const [commentsNotif, setCommentsNotif] = useState(true);
    const [followNotif, setFollowNotif] = useState(true);
    const [mentionsNotif, setMentionsNotif] = useState(true);
    const [messageNotif, setMessageNotif] = useState(true);

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{ title: t("Notifications") }} />
            <View style={styles.content}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Push Notifications")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Enable Push Notifications")}</Text>
                        <Switch
                            value={pushEnabled}
                            onValueChange={setPushEnabled}
                        />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Notification Preferences")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Likes")}</Text>
                        <Switch
                            value={likesNotif}
                            onValueChange={setLikesNotif}
                            disabled={!pushEnabled}
                        />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Comments")}</Text>
                        <Switch
                            value={commentsNotif}
                            onValueChange={setCommentsNotif}
                            disabled={!pushEnabled}
                        />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("New Followers")}</Text>
                        <Switch
                            value={followNotif}
                            onValueChange={setFollowNotif}
                            disabled={!pushEnabled}
                        />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Mentions")}</Text>
                        <Switch
                            value={mentionsNotif}
                            onValueChange={setMentionsNotif}
                            disabled={!pushEnabled}
                        />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Messages")}</Text>
                        <Switch
                            value={messageNotif}
                            onValueChange={setMessageNotif}
                            disabled={!pushEnabled}
                        />
                    </View>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        flex: 1,
        padding: 16,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 16,
        color: '#1a1a1a',
    },
    settingItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
    },
    settingLabel: {
        fontSize: 16,
        color: '#333',
    },
});
