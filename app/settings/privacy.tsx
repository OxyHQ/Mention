import React, { useState, useEffect } from "react";
import { View, Text, SafeAreaView, Switch, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";
import api from "@/utils/api";
import { toast } from "sonner";


export default function PrivacySettings() {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [updating, setUpdating] = useState(false);

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

    useEffect(() => {
        fetchPrivacySettings();
    }, []);

    const fetchPrivacySettings = async () => {
        try {
            const response = await api.get('/privacy');
            const settings = response.data;

            // Update all state values
            setIsPrivateAccount(settings.isPrivateAccount);
            setHideOnlineStatus(settings.hideOnlineStatus);
            setHideLastSeen(settings.hideLastSeen);
            setProfileVisibility(settings.profileVisibility);
            setPostVisibility(settings.postVisibility);
            setTwoFactorEnabled(settings.twoFactorEnabled);
            setLoginAlerts(settings.loginAlerts);
            setBlockScreenshots(settings.blockScreenshots);
            setSecureLogin(settings.secureLogin);
            setBiometricLogin(settings.biometricLogin);
            setShowActivity(settings.showActivity);
            setAllowTagging(settings.allowTagging);
            setAllowMentions(settings.allowMentions);
            setHideReadReceipts(settings.hideReadReceipts);
            setAllowComments(settings.allowComments);
            setAllowDirectMessages(settings.allowDirectMessages);
            setDataSharing(settings.dataSharing);
            setLocationSharing(settings.locationSharing);
            setAnalyticsSharing(settings.analyticsSharing);
            setSensitiveContent(settings.sensitiveContent);
            setAutoFilter(settings.autoFilter);
            setMuteKeywords(settings.muteKeywords);
        } catch (error) {
            toast.error(t("Error loading privacy settings"));
        } finally {
            setLoading(false);
        }
    };

    const updateSetting = async (key: string, value: boolean, setState: (value: boolean) => void) => {
        try {
            await api.put('/privacy', { [key]: value });
        } catch (error) {
            toast.error(t("Error updating setting"));
            // Revert the change on error
            setState(!value);
        } finally {
            setUpdating(false);
        }
    };

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <Header options={{ title: t("Privacy") }} />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{ title: t("Privacy") }} />
            <ScrollView style={styles.content}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Account Privacy")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Private Account")}</Text>
                        <Switch
                            value={isPrivateAccount}
                            onValueChange={(value) => {
                                setIsPrivateAccount(value);
                                updateSetting('isPrivateAccount', value, setIsPrivateAccount);
                            }}
                            disabled={updating}
                        />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Profile Visibility")}</Text>
                        <Switch
                            value={profileVisibility}
                            onValueChange={(value) => {
                                setProfileVisibility(value);
                                updateSetting('profileVisibility', value, setProfileVisibility);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Post Visibility")}</Text>
                        <Switch
                            value={postVisibility}
                            onValueChange={(value) => {
                                setPostVisibility(value);
                                updateSetting('postVisibility', value, setPostVisibility);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Online Status")}</Text>
                        <Switch
                            value={hideOnlineStatus}
                            onValueChange={(value) => {
                                setHideOnlineStatus(value);
                                updateSetting('hideOnlineStatus', value, setHideOnlineStatus);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Last Seen")}</Text>
                        <Switch
                            value={hideLastSeen}
                            onValueChange={(value) => {
                                setHideLastSeen(value);
                                updateSetting('hideLastSeen', value, setHideLastSeen);
                            }}
                            disabled={updating} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Security")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Two-Factor Authentication")}</Text>
                        <Switch
                            value={twoFactorEnabled}
                            onValueChange={(value) => {
                                setTwoFactorEnabled(value);
                                updateSetting('twoFactorEnabled', value, setTwoFactorEnabled);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Secure Login")}</Text>
                        <Switch
                            value={secureLogin}
                            onValueChange={(value) => {
                                setSecureLogin(value);
                                updateSetting('secureLogin', value, setSecureLogin);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Biometric Login")}</Text>
                        <Switch
                            value={biometricLogin}
                            onValueChange={(value) => {
                                setBiometricLogin(value);
                                updateSetting('biometricLogin', value, setBiometricLogin);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Login Alerts")}</Text>
                        <Switch
                            value={loginAlerts}
                            onValueChange={(value) => {
                                setLoginAlerts(value);
                                updateSetting('loginAlerts', value, setLoginAlerts);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Block Screenshots")}</Text>
                        <Switch
                            value={blockScreenshots}
                            onValueChange={(value) => {
                                setBlockScreenshots(value);
                                updateSetting('blockScreenshots', value, setBlockScreenshots);
                            }}
                            disabled={updating} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Interactions")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Show Activity Status")}</Text>
                        <Switch
                            value={showActivity}
                            onValueChange={(value) => {
                                setShowActivity(value);
                                updateSetting('showActivity', value, setShowActivity);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Comments")}</Text>
                        <Switch
                            value={allowComments}
                            onValueChange={(value) => {
                                setAllowComments(value);
                                updateSetting('allowComments', value, setAllowComments);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Direct Messages")}</Text>
                        <Switch
                            value={allowDirectMessages}
                            onValueChange={(value) => {
                                setAllowDirectMessages(value);
                                updateSetting('allowDirectMessages', value, setAllowDirectMessages);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Tagging")}</Text>
                        <Switch
                            value={allowTagging}
                            onValueChange={(value) => {
                                setAllowTagging(value);
                                updateSetting('allowTagging', value, setAllowTagging);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Allow Mentions")}</Text>
                        <Switch
                            value={allowMentions}
                            onValueChange={(value) => {
                                setAllowMentions(value);
                                updateSetting('allowMentions', value, setAllowMentions);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Hide Read Receipts")}</Text>
                        <Switch
                            value={hideReadReceipts}
                            onValueChange={(value) => {
                                setHideReadReceipts(value);
                                updateSetting('hideReadReceipts', value, setHideReadReceipts);
                            }}
                            disabled={updating} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Data & Privacy")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Data Sharing")}</Text>
                        <Switch
                            value={dataSharing}
                            onValueChange={(value) => {
                                setDataSharing(value);
                                updateSetting('dataSharing', value, setDataSharing);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Location Sharing")}</Text>
                        <Switch
                            value={locationSharing}
                            onValueChange={(value) => {
                                setLocationSharing(value);
                                updateSetting('locationSharing', value, setLocationSharing);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Analytics Sharing")}</Text>
                        <Switch
                            value={analyticsSharing}
                            onValueChange={(value) => {
                                setAnalyticsSharing(value);
                                updateSetting('analyticsSharing', value, setAnalyticsSharing);
                            }}
                            disabled={updating} />
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t("Content Filtering")}</Text>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Sensitive Content")}</Text>
                        <Switch
                            value={sensitiveContent}
                            onValueChange={(value) => {
                                setSensitiveContent(value);
                                updateSetting('sensitiveContent', value, setSensitiveContent);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Auto Filter")}</Text>
                        <Switch
                            value={autoFilter}
                            onValueChange={(value) => {
                                setAutoFilter(value);
                                updateSetting('autoFilter', value, setAutoFilter);
                            }}
                            disabled={updating} />
                    </View>
                    <View style={styles.settingItem}>
                        <Text style={styles.settingLabel}>{t("Mute Keywords")}</Text>
                        <Switch
                            value={muteKeywords}
                            onValueChange={(value) => {
                                setMuteKeywords(value);
                                updateSetting('muteKeywords', value, setMuteKeywords);
                            }}
                            disabled={updating} />
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
        backgroundColor: '#fff'
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
    },
    content: {
        flex: 1,
        padding: 16
    },
    section: {
        marginBottom: 24
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16
    },
    settingItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0'
    },
    settingLabel: {
        fontSize: 16
    },
    adFreeBanner: {
        backgroundColor: '#f8f9fa',
        padding: 16,
        borderRadius: 8,
        marginTop: 24,
        marginBottom: 24
    },
    adFreeBannerText: {
        textAlign: 'center',
        color: '#6c757d',
        fontSize: 14
    }
});
