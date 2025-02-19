import React, { useState } from "react";
import { View, Text, StyleSheet, SafeAreaView, Switch, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";

export default function PrivacySettings() {
    const { t } = useTranslation();
    // Account Privacy
    const [isPrivateAccount, setIsPrivateAccount] = useState(false);
    const [hideOnlineStatus, setHideOnlineStatus] = useState(false);
    const [hideLastSeen, setHideLastSeen] = useState(false);
    const [profileVisibility, setProfileVisibility] = useState(true);
    const [postVisibility, setPostVisibility] = useState(true);

    // Security
    const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
    const [loginAlerts, setLoginAlerts] = useState(true);
    const [blockScreenshots, setBlockScreenshots] = useState(false);
    const [secureLogin, setSecureLogin] = useState(true);
    const [biometricLogin, setBiometricLogin] = useState(false);

    // Interactions
    const [showActivity, setShowActivity] = useState(true);
    const [allowTagging, setAllowTagging] = useState(true);
    const [allowMentions, setAllowMentions] = useState(true);
    const [hideReadReceipts, setHideReadReceipts] = useState(false);
    const [allowComments, setAllowComments] = useState(true);
    const [allowDirectMessages, setAllowDirectMessages] = useState(true);

    // Data & Privacy
    const [dataSharing, setDataSharing] = useState(true);
    const [locationSharing, setLocationSharing] = useState(false);
    const [analyticsSharing, setAnalyticsSharing] = useState(true);

    // Content Filtering
    const [sensitiveContent, setSensitiveContent] = useState(false);
    const [autoFilter, setAutoFilter] = useState(true);
    const [muteKeywords, setMuteKeywords] = useState(false);

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{ title: t("Privacy") }} />
            <ScrollView style={styles.content}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Account Privacy")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Private Account")}</Text>
                        <Switch value={isPrivateAccount} onValueChange={setIsPrivateAccount} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Profile Visibility")}</Text>
                        <Switch value={profileVisibility} onValueChange={setProfileVisibility} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Post Visibility")}</Text>
                        <Switch value={postVisibility} onValueChange={setPostVisibility} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Online Status")}</Text>
                        <Switch value={hideOnlineStatus} onValueChange={setHideOnlineStatus} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Last Seen")}</Text>
                        <Switch value={hideLastSeen} onValueChange={setHideLastSeen} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Security")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Two-Factor Authentication")}</Text>
                        <Switch value={twoFactorEnabled} onValueChange={setTwoFactorEnabled} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Secure Login")}</Text>
                        <Switch value={secureLogin} onValueChange={setSecureLogin} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Biometric Login")}</Text>
                        <Switch value={biometricLogin} onValueChange={setBiometricLogin} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Login Alerts")}</Text>
                        <Switch value={loginAlerts} onValueChange={setLoginAlerts} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Block Screenshots")}</Text>
                        <Switch value={blockScreenshots} onValueChange={setBlockScreenshots} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Interactions")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Show Activity Status")}</Text>
                        <Switch value={showActivity} onValueChange={setShowActivity} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Comments")}</Text>
                        <Switch value={allowComments} onValueChange={setAllowComments} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Direct Messages")}</Text>
                        <Switch value={allowDirectMessages} onValueChange={setAllowDirectMessages} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Tagging")}</Text>
                        <Switch value={allowTagging} onValueChange={setAllowTagging} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Mentions")}</Text>
                        <Switch value={allowMentions} onValueChange={setAllowMentions} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Read Receipts")}</Text>
                        <Switch value={hideReadReceipts} onValueChange={setHideReadReceipts} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Data & Privacy")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Data Sharing")}</Text>
                        <Switch value={dataSharing} onValueChange={setDataSharing} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Location Sharing")}</Text>
                        <Switch value={locationSharing} onValueChange={setLocationSharing} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Analytics Sharing")}</Text>
                        <Switch value={analyticsSharing} onValueChange={setAnalyticsSharing} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Content Filtering")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Sensitive Content")}</Text>
                        <Switch value={sensitiveContent} onValueChange={setSensitiveContent} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Auto Filter")}</Text>
                        <Switch value={autoFilter} onValueChange={setAutoFilter} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Mute Keywords")}</Text>
                        <Switch value={muteKeywords} onValueChange={setMuteKeywords} />
                    </View>
                </View>
                <View style={styles.adFreeBanner}>
                    <Text style={styles.adFreeBannerText}>{t("Mention is completely free of ads - we respect your privacy")}</Text>
                </View>
            </ScrollView>
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
    adFreeBanner: {
        backgroundColor: '#e8f5e9',
        padding: 16,
        borderRadius: 35,
        alignItems: 'center',
    },
    adFreeBannerText: {
        fontSize: 16,
        color: '#2e7d32',
        textAlign: 'center',
        fontWeight: '500',
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
