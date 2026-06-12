import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';

import { useTheme } from '@/hooks/useTheme';

export default function SettingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => signOut?.(),
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Settings</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SettingsListGroup>
          <SettingsListItem
            icon={<Ionicons name="person-outline" size={20} color={theme.colors.textSecondary} />}
            title="Account"
            onPress={() => {}}
          />
          <SettingsListItem
            icon={<Ionicons name="notifications-outline" size={20} color={theme.colors.textSecondary} />}
            title="Notifications"
            onPress={() => {}}
          />
          <SettingsListItem
            icon={<Ionicons name="color-palette-outline" size={20} color={theme.colors.textSecondary} />}
            title="Appearance"
            onPress={() => {}}
          />
          <SettingsListItem
            icon={<Ionicons name="information-circle-outline" size={20} color={theme.colors.textSecondary} />}
            title="About"
            onPress={() => {}}
          />
        </SettingsListGroup>

        <SettingsListGroup>
          <SettingsListItem
            icon={<Ionicons name="log-out-outline" size={20} color={theme.colors.error} />}
            title="Sign Out"
            onPress={handleLogout}
            destructive
            showChevron={false}
          />
        </SettingsListGroup>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  content: { paddingVertical: 8 },
});
