import React, { useEffect, useState, useContext } from 'react';
import { View, Image, TouchableOpacity, Text, ActivityIndicator, StyleSheet, Platform, ViewStyle } from 'react-native';
import { router, useLocalSearchParams, Link } from "expo-router";
import Feed from '@/components/Feed';
import { colors } from "@/styles/colors";
import { SafeAreaView } from 'react-native-safe-area-context';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { FollowButton } from '@/modules/oxyhqservices';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { Ionicons } from "@expo/vector-icons";
import { Chat as ChatIcon } from '@/assets/icons/chat-icon';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import Avatar from "@/components/Avatar";
import { profileService } from '@/modules/oxyhqservices/services';
import type { OxyProfile } from '@/modules/oxyhqservices/types';
import { OXY_CLOUD_URL } from '@/modules/oxyhqservices/config';

export default function ProfileScreen() {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");
  const [profile, setProfile] = useState<OxyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionContext = useContext(SessionContext);
  const currentUserId = sessionContext?.getCurrentUserId();
  const { t } = useTranslation();
  const [isAvatarModalVisible, setIsAvatarModalVisible] = useState(false);
  const [isCoverModalVisible, setIsCoverModalVisible] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const handleFollowStatusChange = (isFollowing: boolean) => {
    if (profile && profile._count) {
      setProfile({
        ...profile,
        _count: {
          ...profile._count,
          followers: profile._count.followers + (isFollowing ? 1 : -1)
        }
      });
    }
  };

  const handleUpdateProfile = async (updateData: Partial<OxyProfile>) => {
    if (!profile?._id || !currentUserId) return;

    setIsUpdating(true);
    try {
      const updatedProfile = await profileService.updateProfile({
        _id: profile._id,
        ...updateData
      });
      setProfile(updatedProfile);
      toast.success(t('Profile updated successfully'));
    } catch (error) {
      toast.error(t('Failed to update profile'));
      console.error('Profile update error:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAvatarSelect = async (files: any[]) => {
    if (files.length > 0) {
      await handleUpdateProfile({ avatar: files[0]._id });
    }
    setIsAvatarModalVisible(false);
  };

  const handleCoverSelect = async (files: any[]) => {
    if (files.length > 0) {
      await handleUpdateProfile({ coverPhoto: files[0]._id });
    }
    setIsCoverModalVisible(false);
  };

  useEffect(() => {
    const fetchProfileData = async () => {
      if (!localUsername) return;

      try {
        setLoading(true);
        setError(null);
        const username = localUsername.replace('@', '');
        const profile = await profileService.getProfileByUsername(username);

        if (!profile) {
          throw new Error(`User not found: ${username}`);
        }

        setProfile(profile);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load profile';
        setError(errorMessage);
        setProfile(null);
        toast.error(t(errorMessage));
      } finally {
        setLoading(false);
      }
    };

    fetchProfileData();
  }, [localUsername, t]);

  if (loading) {
    return (
      <SafeAreaView>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primaryColor} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !profile) {
    return (
      <SafeAreaView>
        <View style={styles.errorContainer}>
          <Text>{error || 'Profile not found'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isOwnProfile = currentUserId === profile?._id;

  // Add premium badge if user has premium status
  const renderPremiumBadge = () => {
    if (profile?.premium?.isPremium) {
      return (
        <View className="flex-row items-center bg-yellow-100 px-2 py-1 rounded-full ml-2">
          <Ionicons name="star" size={14} color="#FFD700" />
          <Text className="text-yellow-800 text-xs ml-1 font-medium">
            {profile.premium.subscriptionTier?.toUpperCase() || 'PREMIUM'}
          </Text>
        </View>
      );
    }
    return null;
  };

  // Render user stats section
  const renderStats = () => {
    if (!profile) return null;

    const stats = {
      posts: profile._count?.posts || profile.stats?.posts || 0,
      following: profile._count?.following || profile.stats?.following || 0,
      followers: profile._count?.followers || profile.stats?.followers || 0,
      karma: profile._count?.karma || profile.stats?.karma || 0
    };

    return (
      <View className="flex-row justify-around py-4 border-b border-gray-100">
        <View className="items-center">
          <Text className="font-bold">{stats.posts}</Text>
          <Text className="text-gray-500 text-sm">Posts</Text>
        </View>
        <View className="items-center">
          <Text className="font-bold">{stats.following}</Text>
          <Text className="text-gray-500 text-sm">Following</Text>
        </View>
        <View className="items-center">
          <Text className="font-bold">{stats.followers}</Text>
          <Text className="text-gray-500 text-sm">Followers</Text>
        </View>
        <View className="items-center">
          <Text className="font-bold">{stats.karma}</Text>
          <Text className="text-gray-500 text-sm">Karma</Text>
        </View>
      </View>
    );
  };

  // Render user's associated content
  const renderAssociatedContent = () => {
    if (!profile?.associated) return null;

    return (
      <View className="px-4 py-2 border-b border-gray-100">
        <Text className="font-bold mb-2">Associated Content</Text>
        <View className="flex-row flex-wrap">
          {profile.associated.feedgens && profile.associated.feedgens > 0 && (
            <View className="bg-gray-100 rounded-full px-3 py-1 mr-2 mb-2">
              <Text className="text-xs">{profile.associated.feedgens} Feed Generators</Text>
            </View>
          )}
          {profile.associated.lists && profile.associated.lists > 0 && (
            <View className="bg-gray-100 rounded-full px-3 py-1 mr-2 mb-2">
              <Text className="text-xs">{profile.associated.lists} Lists</Text>
            </View>
          )}
          {profile.associated.starterPacks && profile.associated.starterPacks > 0 && (
            <View className="bg-gray-100 rounded-full px-3 py-1 mr-2 mb-2">
              <Text className="text-xs">{profile.associated.starterPacks} Starter Packs</Text>
            </View>
          )}
          {profile.associated.labeler && (
            <View className="bg-gray-100 rounded-full px-3 py-1 mr-2 mb-2">
              <Text className="text-xs">Labeler</Text>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color={colors.primaryColor} />
        </View>
      ) : error ? (
        <View className="flex-1 justify-center items-center p-4">
          <Text className="text-red-500 text-center">{error}</Text>
        </View>
      ) : profile ? (
        <View className="flex-1">
          <View className="relative">
            {profile.coverPhoto ? (
              <Image
                source={{ uri: `${OXY_CLOUD_URL}/${profile.coverPhoto}` }}
                className="w-full h-40"
                style={{ resizeMode: 'cover' }}
              />
            ) : (
              <View className="w-full h-40 bg-gray-200" />
            )}
            {isOwnProfile && (
              <TouchableOpacity
                className="absolute top-2 right-2 bg-black/30 rounded-full p-2"
                onPress={() => setIsCoverModalVisible(true)}
              >
                <Ionicons name="camera" size={20} color="white" />
              </TouchableOpacity>
            )}
            <View className="absolute -bottom-16 left-4">
              <View className="relative">
                <Avatar id={profile.avatar} size={80} />
                {isOwnProfile && (
                  <TouchableOpacity
                    className="absolute bottom-0 right-0 bg-primary rounded-full p-1"
                    onPress={() => setIsAvatarModalVisible(true)}
                  >
                    <Ionicons name="camera" size={16} color="white" />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>

          <View className="mt-20 px-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center">
                <Text className="text-xl font-bold">
                  {profile.name?.first ? `${profile.name.first} ${profile.name.last || ''}`.trim() : profile.username}
                </Text>
                {renderPremiumBadge()}
              </View>
              {!isOwnProfile && profile._id && (
                <View className="flex-row">
                  <View style={{ marginRight: 8 }}>
                    <FollowButton
                      userId={profile._id}
                      onFollowStatusChange={handleFollowStatusChange}
                    />
                  </View>
                  <TouchableOpacity
                    className="bg-gray-100 p-2 rounded-full"
                    onPress={() => router.push(`/messages/${profile._id}`)}
                  >
                    <ChatIcon size={20} color="#000" />
                  </TouchableOpacity>
                </View>
              )}
              {isOwnProfile && (
                <TouchableOpacity
                  className="bg-gray-100 py-1 px-4 rounded-full"
                  onPress={() => router.push('/settings/profile/edit')}
                >
                  <Text>Edit Profile</Text>
                </TouchableOpacity>
              )}
            </View>

            <Text className="text-gray-500 mb-2">@{profile.username}</Text>

            {profile.description && (
              <Text className="mb-2">{profile.description}</Text>
            )}

            <View className="flex-row flex-wrap mb-2">
              {profile.location && (
                <View className="flex-row items-center mr-4">
                  <Ionicons name="location-outline" size={16} color="gray" />
                  <Text className="text-gray-500 ml-1">{profile.location}</Text>
                </View>
              )}
              {profile.website && (
                <View className="flex-row items-center mr-4">
                  <Ionicons name="link-outline" size={16} color="gray" />
                  <Text className="text-primary ml-1">{profile.website}</Text>
                </View>
              )}
              {profile.createdAt && (
                <View className="flex-row items-center">
                  <Ionicons name="calendar-outline" size={16} color="gray" />
                  <Text className="text-gray-500 ml-1">
                    Joined {new Date(profile.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {renderStats()}
          {renderAssociatedContent()}

          <View className="flex-1">
            <Feed
              type="profile"
              userId={profile._id}
              showCreatePost={false}
            />
          </View>
        </View>
      ) : null}

      <FileSelectorModal
        isVisible={isAvatarModalVisible}
        onClose={() => setIsAvatarModalVisible(false)}
        onSelect={handleAvatarSelect}
        options={{
          fileTypeFilter: ["image/"],
          maxFiles: 1
        }}
      />

      <FileSelectorModal
        isVisible={isCoverModalVisible}
        onClose={() => setIsCoverModalVisible(false)}
        onSelect={handleCoverSelect}
        options={{
          fileTypeFilter: ["image/"],
          maxFiles: 1
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  coverPhoto: {
    width: '100%',
    height: 160,
    borderRadius: 35,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
  },
  avatar: {
    borderWidth: 4,
    marginTop: -40,
    borderColor: colors.primaryLight,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.2s ease',
        ':hover': {
          transform: [{ scale: 1.05 }],
        },
      },
    }),
  },
  coverPhotoButton: {
    width: '100%',
    height: 160,
    borderRadius: 35,
    overflow: 'hidden',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'opacity 0.2s ease',
        ':hover': {
          opacity: 0.9,
        },
      },
    }),
  },
  profileButtons: {
    position: "absolute",
    right: 15,
    top: 15,
    flexDirection: "row",
    gap: 10,
  },
  profileInfo: {
    padding: 15,
  },
  ProfileButton: {
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: colors.COLOR_BACKGROUND,
  },
  ProfileButtonText: {
    color: colors.primaryColor,
    fontWeight: "bold",
  },
  ProfileButtonBack: {
    borderRadius: 35,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: colors.COLOR_BACKGROUND,
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 1,
    borderWidth: 4,
    borderColor: colors.primaryLight,
  },
  name: {
    fontSize: 30,
    fontWeight: "bold",
    marginTop: 10,
  },
  usernameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  username: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  lockIcon: {
    marginLeft: 4,
  },
  bio: {
    marginBottom: 10,
  },
  userDetails: {
    marginBottom: 10,
  },
  userDetailItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 5,
  },
  userDetailText: {
    color: colors.COLOR_BLACK_LIGHT_3,
    marginLeft: 5,
  },
  link: {
    color: colors.primaryColor,
    fontWeight: "bold",
  },
  statsContainer: {
    flexDirection: "row",
    gap: 10,
  },
  statText: {
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  statTextHover: {
    borderBottomWidth: 1,
    borderBottomColor: colors.primaryColor,
  },
  statCount: {
    color: colors.COLOR_BLACK,
    fontWeight: "bold",
  },
  tabContainer: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
    ...Platform.select({
      web: {
        position: "sticky",
        top: 0,
        zIndex: 1,
        backgroundColor: colors.primaryLight,
      },
    }),
  } as ViewStyle,
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 15,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primaryColor,
  },
  tabText: {
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  activeTabText: {
    color: colors.primaryColor,
    fontWeight: "bold",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
});