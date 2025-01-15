import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, SafeAreaView, TouchableOpacity, FlatList } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import Post from "@/components/Post";
import { Post as PostType } from "@/interfaces/Post";
import { useColorScheme } from "@/hooks/useColorScheme";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { Stack, Link } from "expo-router";
import { colors } from "@/styles/colors";
import { Header } from "@/components/Header";
import { toast } from '@/lib/sonner';


const languages = ["en", "es", "it"];
const colorsArray = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];


const post: PostType = {
  id: "1",
  text: "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
  source: "web",
  in_reply_to_user_id: null,
  in_reply_to_username: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  author: {
    id: "1",
    username: "mention",
    name: "Mention",
    image: "https://example.com/profile.jpg",
    email: "hello@mention.earth",
    description: "A new social network for a new world.",
    color: "#000000",
  },
  media: [],
  quoted_post: null,
  _count: {
    likes: 0,
    reposts: 0,
    bookmarks: 0,
    replies: 0,
    comments: 0,
    quotes: 0,
  },
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
    <TouchableOpacity style={styles.settingItem}>
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
  const [selectedColor, setSelectedColor] = useState(colorsArray[0]);
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
        <Header options={{
          leftComponents: [<Ionicons name="settings" size={24} color={colors.COLOR_BLACK} />],
          title: t("Customize your view"),
          subtitle: t("These settings affect all the Mention accounts on this device."),
          rightComponents: [<Ionicons name="add" size={24} color={colors.COLOR_BLACK} onPress={() => toast('My first toast')} />],
        }} />
        <ThemedView style={styles.container}>
          {post && <Post postData={post} showActions={false} />}
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
    padding: 16,
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
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