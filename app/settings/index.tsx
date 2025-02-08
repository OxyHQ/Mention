import React, { useState, useContext, useEffect } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, SafeAreaView, TouchableOpacity, FlatList } from "react-native";
import { Post as PostType } from "@/interfaces/Post";
import { useColorScheme } from "@/hooks/useColorScheme";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { Stack, Link } from "expo-router";
import { colors } from "@/styles/colors";
import { Header } from "@/components/Header";
import { toast } from '@/lib/sonner';
import Avatar from "@/components/Avatar";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useDispatch, useSelector } from "react-redux";
import { RootState, AppDispatch } from "@/store/store";
import { fetchProfile } from "@/store/reducers/profileReducer";


const languages = ["en", "es", "it"];
const colorsArray = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

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

  // Add SessionContext integration with correct dispatch type
  const sessionContext = useContext(SessionContext);
  const currentUser = sessionContext?.getCurrentUser();
  const dispatch = useDispatch<AppDispatch>();
  const { profile, loading } = useSelector((state: RootState) => state.profile);

  useEffect(() => {
    if (currentUser?.username) {
      dispatch(fetchProfile({ username: currentUser.username }));
    }
  }, [currentUser?.username, dispatch]);

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
      title: t('Profile'),
      subtitle: t('Manage your account settings'),
      link: "/settings/profile",
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
          title: t("Settings"),
          rightComponents: [<Ionicons name="add" size={24} color={colors.COLOR_BLACK} onPress={() => toast('My first toast')} />],
        }} />
        <View style={styles.accountContainer}>
          <Avatar size={80} id={currentUser?.avatar} />
            <Text style={styles.accountTitle}>
            {profile?.name?.first} {profile?.name?.last ? ` ${profile.name.last}` : ''}
            </Text>
          <Text style={styles.accountHandle}>@{currentUser?.username}</Text>
        </View>
        <SettingItem 
          icon="information-circle" 
          title={t('Edit Profile')} 
          subtitle={t('Update your profile information')} 
          link="/settings/profile/edit" 
        />
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
  accountContainer: {
    flexDirection: 'column',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
  },
  accountTitle: {
    fontSize: 30,
    fontWeight: '700',
    color: '#000',
  },
  accountHandle: {
    fontSize: 18,
    color: '#666',
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
});