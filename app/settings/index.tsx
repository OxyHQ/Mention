import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, SafeAreaView, TouchableOpacity, FlatList } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import Post from "@/components/Post";
import { useColorScheme } from "@/hooks/useColorScheme";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { Stack, Link } from "expo-router";


const languages = ["en", "es", "it"];
const colors = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

const post = {
  id: "16",
  avatar: "/assets/images/favicon.png",
  name: "Mention",
  username: "@mention",
  content:
    "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
  time: "16m",
  likes: 7,
  reposts: 3,
  replies: 2,
  isReply: false,
  hasMedia: false,
  isLiked: true,
};

interface SettingItemProps {
  icon: string;
  title: string;
  subtitle: string;
  link?: string;
  onPress?: () => void;
}

const SettingItem: React.FC<SettingItemProps> = ({ icon, title, subtitle, link, onPress }) => (
  <Link href={link as any} asChild>
    <TouchableOpacity style={styles.settingItem} onPress={onPress}>
      <View style={styles.iconContainer}>
        <Ionicons name={icon as any} size={24} color="#333" />
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </TouchableOpacity>
  </Link>
);

const SettingsHeader: React.FC = () => {
  const { t } = useTranslation();
  return (
    <View style={styles.headerContainer}>
      <Text style={styles.headerTitle}>{t("Customize your view")}</Text>
      <Text style={styles.headerSubtitle}>
        {t("These settings affect all the Mention accounts on this device.")}
      </Text>
    </View>
  );
};

const SettingsSearch: React.FC<{ onSearch: (text: string) => void }> = ({ onSearch }) => (
  <View style={styles.searchContainer}>
    <Ionicons name="search" size={24} color="#666" style={styles.searchIcon} />
    <TextInput
      style={styles.searchInput}
      placeholder="Search settings"
      placeholderTextColor="#666"
      onChangeText={onSearch}
    />
  </View>
);

export default function SettingsScreen() {
  const batteryLevel = 0.5;
  const colorScheme = useColorScheme();
  const { t } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(languages[0]);
  const [selectedColor, setSelectedColor] = useState(colors[0]);
  const [searchText, setSearchText] = useState("");

  const getBatteryIcon = (level: number | null) => {
    if (level === null) return 'battery-unknown';
    if (level >= 0.75) return 'battery-full';
    if (level >= 0.5) return 'battery-half';
    if (level >= 0.25) return 'battery-quarter';
    return 'battery-empty';
  };

  const settings = [
    {
      icon: 'person',
      title: t('Account'),
      subtitle: t('Manage your account settings'),
      link: "/settings/account",
    },
    {
      icon: 'notifications',
      title: t('Notifications'),
      subtitle: t('Notification preferences'),
      link: "/settings/notifications",
    },
    {
      icon: 'lock-closed',
      title: t('Privacy'),
      subtitle: t('Privacy and security settings'),
      link: "/settings/privacy",
    },
    {
      icon: 'color-palette',
      title: t('Appearance'),
      subtitle: t('Theme, font size, colors'),
      link: "/settings/display",
    },
    {
      icon: 'language',
      title: t('Language'),
      subtitle: t('Change app language'),
      link: "/settings/languages",
    },
    {
      icon: 'help-circle',
      title: t('Help & Support'),
      subtitle: t('Get help and support'),
      link: "/settings/help",
    },
    {
      icon: 'information-circle',
      title: t('About'),
      subtitle: t('About this app'),
      link: "/settings/about",
    },
    {
      icon: getBatteryIcon(batteryLevel),
      title: t('Battery'),
      subtitle: batteryLevel !== null ? `${Math.round(batteryLevel * 100)}%` : t('Loading...'),
      link: "/settings/battery",
    },
  ];

  const filteredSettings = settings.filter(setting =>
    setting.title.toLowerCase().includes(searchText.toLowerCase()) ||
    setting.subtitle.toLowerCase().includes(searchText.toLowerCase())
  );

  return (
    <>
      <Stack.Screen options={{ title: t("Settings") }} />
      <SafeAreaView style={styles.container}>
        <SettingsHeader />
        <ThemedView style={styles.container}>
          {post && <Post {...post} showActions={false} />}
        </ThemedView>
        <SettingsSearch onSearch={setSearchText} />
        <FlatList
          style={styles.scrollView}
          data={filteredSettings}
          keyExtractor={(item, index) => index.toString()}
          renderItem={({ item }) => <SettingItem {...item} />}
        />
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
  },
  headerContainer: {
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000',
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 4,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    padding: 8,
    backgroundColor: '#fff',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#ddd',
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
    padding: 16,
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  iconContainer: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
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
});