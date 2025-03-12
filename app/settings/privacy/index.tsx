import React, { useState, useEffect } from 'react';
import { View, StyleSheet, ScrollView, Switch, TouchableOpacity, SafeAreaView, Text } from 'react-native';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { useTranslation } from 'react-i18next';
import { getPrivacyService } from '@/modules/oxyhqservices';
import { useAuth } from '@/modules/oxyhqservices/hooks';
import { toast } from 'sonner';

export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [settings, setSettings] = useState({
    isPrivateAccount: false,
    hideOnlineStatus: false,
    hideLastSeen: false,
    profileVisibility: true,
    postVisibility: true,
    twoFactorEnabled: false,
    loginAlerts: true,
    blockScreenshots: false,
    secureLogin: true,
    biometricLogin: false,
    showActivity: true,
    allowTagging: true,
    allowMentions: true,
    hideReadReceipts: false,
    allowComments: true,
    allowDirectMessages: true,
    dataSharing: true,
    locationSharing: false,
    analyticsSharing: true,
    sensitiveContent: false,
    autoFilter: true,
    muteKeywords: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.id) {
      loadPrivacySettings();
    }
  }, [user?.id]);

  const loadPrivacySettings = async () => {
    try {
      // Using the getter function to get the privacy service instance
      const privacyService = getPrivacyService();
      const userSettings = await privacyService.getPrivacySettings(user!.id);
      setSettings(userSettings);
    } catch (error) {
      toast.error(t('Error loading privacy settings'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggleSetting = async (setting: keyof typeof settings) => {
    try {
      const updatedSettings = {
        ...settings,
        [setting]: !settings[setting]
      };
      setSettings(updatedSettings);
      
      // Using the getter function to get the privacy service instance
      const privacyService = getPrivacyService();
      await privacyService.updatePrivacySettings(user!.id, updatedSettings);
    } catch (error) {
      toast.error(t('Error updating setting'));
      // Revert the setting if update failed
      setSettings(settings);
    }
  };

  const privacyGroups = [
    {
      title: t('Account Privacy'),
      settings: [
        { key: 'isPrivateAccount', label: t('Private Account') },
        { key: 'hideOnlineStatus', label: t('Hide Online Status') },
        { key: 'hideLastSeen', label: t('Hide Last Seen') },
        { key: 'profileVisibility', label: t('Profile Visibility') },
        { key: 'postVisibility', label: t('Post Visibility') },
      ],
    },
    {
      title: t('Security'),
      settings: [
        { key: 'twoFactorEnabled', label: t('Two-Factor Authentication') },
        { key: 'loginAlerts', label: t('Login Alerts') },
        { key: 'blockScreenshots', label: t('Block Screenshots') },
        { key: 'secureLogin', label: t('Secure Login') },
        { key: 'biometricLogin', label: t('Biometric Login') },
      ],
    },
    {
      title: t('Interactions'),
      settings: [
        { key: 'showActivity', label: t('Show Activity Status') },
        { key: 'allowTagging', label: t('Allow Tagging') },
        { key: 'allowMentions', label: t('Allow Mentions') },
        { key: 'hideReadReceipts', label: t('Hide Read Receipts') },
        { key: 'allowComments', label: t('Allow Comments') },
        { key: 'allowDirectMessages', label: t('Allow Direct Messages') },
      ],
    },
    {
      title: t('Data & Sharing'),
      settings: [
        { key: 'dataSharing', label: t('Data Sharing') },
        { key: 'locationSharing', label: t('Location Sharing') },
        { key: 'analyticsSharing', label: t('Analytics Sharing') },
      ],
    },
    {
      title: t('Content Filtering'),
      settings: [
        { key: 'sensitiveContent', label: t('Show Sensitive Content') },
        { key: 'autoFilter', label: t('Auto-Filter Content') },
        { key: 'muteKeywords', label: t('Mute Keywords') },
      ],
    },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <Header
        options={{
          title: t('Privacy Settings'),
          showBackButton: true,
        }}
      />
      <ScrollView style={styles.scrollView}>
        {privacyGroups.map((group, groupIndex) => (
          <View key={groupIndex} style={styles.section}>
            <Text style={styles.sectionTitle}>{group.title}</Text>
            {group.settings.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={styles.settingItem}
                onPress={() => handleToggleSetting(key as keyof typeof settings)}
              >
                <Text style={styles.settingLabel}>{label}</Text>
                <Switch
                  value={settings[key as keyof typeof settings]}
                  onValueChange={() => handleToggleSetting(key as keyof typeof settings)}
                  trackColor={{ false: colors.COLOR_BLACK_LIGHT_6, true: colors.primaryColor }}
                />
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollView: {
    flex: 1,
  },
  section: {
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    color: colors.COLOR_BLACK,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  settingLabel: {
    fontSize: 16,
    color: colors.COLOR_BLACK,
  },
});
