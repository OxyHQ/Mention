import React, { useState, useEffect } from 'react';
import { View, StyleSheet, FlatList, TouchableOpacity, SafeAreaView, ActivityIndicator } from 'react-native';
import { Text } from 'react-native';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { useTranslation } from 'react-i18next';
import { getPrivacyService } from '@/modules/oxyhqservices';
import { useAuth } from '@/modules/oxyhqservices/hooks';
import { toast } from 'sonner';
import Avatar from '@/components/Avatar';
import { Ionicons } from '@expo/vector-icons';

interface BlockedUser {
  _id: string;
  username: string;
  avatar?: string;
  blockedAt: Date;
}

export default function BlockedUsersScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.id) {
      loadBlockedUsers();
    }
  }, [user?.id]);

  const loadBlockedUsers = async () => {
    try {
      // Using the getter function to get the privacy service instance
      const privacyService = getPrivacyService();
      const users = await privacyService.getBlockedUsers(user!.id);
      setBlockedUsers(users);
    } catch (error) {
      toast.error(t('Error loading blocked users'));
    } finally {
      setLoading(false);
    }
  };

  const handleUnblock = async (targetId: string) => {
    try {
      // Using the getter function to get the privacy service instance
      const privacyService = getPrivacyService();
      await privacyService.unblockUser(targetId);
      setBlockedUsers(prev => prev.filter(u => u._id !== targetId));
      toast.success(t('User unblocked successfully'));
    } catch (error) {
      toast.error(t('Error unblocking user'));
    }
  };

  const renderItem = ({ item }: { item: BlockedUser }) => (
    <View style={styles.userItem}>
      <View style={styles.userInfo}>
        <Avatar id={item.avatar} size={40} />
        <View style={styles.textContainer}>
          <Text style={styles.username}>@{item.username}</Text>
          <Text style={styles.blockedDate}>
            {t('Blocked on')} {new Date(item.blockedAt).toLocaleDateString()}
          </Text>
        </View>
      </View>
      <TouchableOpacity
        style={styles.unblockButton}
        onPress={() => handleUnblock(item._id)}
      >
        <Ionicons name="person-remove-outline" size={20} color={colors.primaryColor} />
        <Text style={styles.unblockText}>{t('Unblock')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Header
        options={{
          title: t('Blocked Users'),
          showBackButton: true,
        }}
      />
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primaryColor} />
        </View>
      ) : blockedUsers.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>{t('No blocked users')}</Text>
        </View>
      ) : (
        <FlatList
          data={blockedUsers}
          renderItem={renderItem}
          keyExtractor={item => item._id}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  listContent: {
    padding: 16,
  },
  userItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  textContainer: {
    marginLeft: 12,
  },
  username: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK,
  },
  blockedDate: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginTop: 2,
  },
  unblockButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.primaryColor,
  },
  unblockText: {
    marginLeft: 4,
    fontSize: 14,
    color: colors.primaryColor,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  emptyText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
    textAlign: 'center',
  },
});