import React, { useEffect, useState, useContext } from 'react';
import { View, Image, TouchableOpacity, Text, ActivityIndicator, StyleSheet, Platform, ViewStyle } from 'react-native';
import { router, useLocalSearchParams, Link } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { colors } from "@/styles/colors";
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { profileService, FollowButton } from '@/modules/oxyhqservices';
import { getUsernameToId } from '@/modules/oxyhqservices/reducers/profileReducer';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { Ionicons } from "@expo/vector-icons";
import { Chat as ChatIcon } from '@/assets/icons/chat-icon';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import Avatar from "@/components/Avatar";
import Post from "@/components/Post";
import type { AppDispatch } from '@/store/store';
import type { OxyProfile } from '@/modules/oxyhqservices/types';

export default function ProfileScreen() {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");
  const dispatch = useDispatch<AppDispatch>();
  const [profile, setProfile] = useState<OxyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const posts = useSelector((state: { posts: { posts: any[] } }) => state.posts.posts);
  const sessionContext = useContext(SessionContext);
  const currentUser = sessionContext?.getCurrentUser();
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
    if (!profile?.userID || !currentUser) return;
    
    setIsUpdating(true);
    try {
      const updatedProfile = await profileService.updateProfile({
        userID: profile.userID,
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
        const userId = await getUsernameToId({ username });
        
        if (!userId) {
          throw new Error(`User not found: ${username}`);
        }
        
        const profileData = await profileService.getProfileById(userId);
        if (!profileData) {
          throw new Error('Failed to load profile data');
        }
        
        setProfile(profileData);
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
    dispatch(fetchPosts());
  }, [dispatch, localUsername, t]);

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

  const isOwnProfile = currentUser?.username === profile?.username;
  
  return (
    <SafeAreaView>
      <View>
        <View style={{ padding: 15 }}>
          {router.canGoBack() && (
            <View style={styles.ProfileButtonBack}>
              <TouchableOpacity onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={20} color={colors.primaryColor} />
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity 
            onPress={() => isOwnProfile && setIsCoverModalVisible(true)}
            disabled={!isOwnProfile || isUpdating}
            style={styles.coverPhotoButton}
          >
            {profile.coverPhoto ? (
              <Image source={{ uri: profile.coverPhoto }} style={styles.coverPhoto} />
            ) : (
              <View className="w-full h-40 rounded-[35px] bg-black flex justify-center items-center">
                {isOwnProfile && (
                  <>
                    <Ionicons name="camera" size={40} color="white" className="mb-2.5" />
                    <Text className="text-white text-lg font-bold mb-2.5">{t('Add a cover photo')}</Text>
                  </>
                )}
              </View>
            )}
          </TouchableOpacity>
          
          <View style={styles.profileInfo}>
            <TouchableOpacity
              onPress={() => isOwnProfile && setIsAvatarModalVisible(true)}
              disabled={!isOwnProfile || isUpdating}
            >
              <Avatar style={styles.avatar} id={profile.avatar} size={100} />
            </TouchableOpacity>
            <View style={styles.profileButtons}>
              {!isOwnProfile && (
                <>
                  <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                    console.log("Chat button pressed");
                  }}>
                    <ChatIcon size={20} color={colors.primaryColor} />
                  </TouchableOpacity>
                  <FollowButton 
                    userId={profile.userID}
                    onFollowStatusChange={handleFollowStatusChange}
                  />
                </>
              )}
              {isOwnProfile && (
                <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                  router.push('/settings/profile/edit');
                }}>
                  <Text style={styles.ProfileButtonText}>Edit profile</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                console.log("More options button pressed");
              }}>
                <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
              </TouchableOpacity>
            </View>
            <Text style={styles.name}>
              {profile.name?.first ? `${profile.name.first} ${profile.name.last || ''}` : profile.username}
            </Text>
            <View style={styles.usernameContainer}>
              <Text style={styles.username}>@{profile.username}</Text>
              {profile.privacySettings?.isPrivateAccount && (
                <Ionicons name="lock-closed" size={16} color={colors.COLOR_BLACK_LIGHT_3} style={styles.lockIcon} />
              )}
            </View>
            {profile.description && (
              <Text style={styles.bio}>{profile.description}</Text>
            )}
            <View style={styles.userDetails}>
              {profile.location && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="location-outline" size={16} color="gray" />
                  <Text style={styles.userDetailText}>{profile.location}</Text>
                </View>
              )}
              {profile.website && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="link-outline" size={16} color="gray" />
                  <Link href={profile.website} style={styles.link}>
                    {profile.website.replace(/^https?:\/\//, '')}
                  </Link>
                </View>
              )}
            </View>
            <View style={styles.statsContainer}>
              <Link href={`/@${profile?.username || localUsername?.replace('@', '')}`} style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.following || 0}</Text> Following
              </Link>
              <Link href={`/@${profile?.username || localUsername?.replace('@', '')}/followers`} style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.followers || 0}</Text> Followers
              </Link>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.posts || 0}</Text> Posts
              </Text>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.karma || 0}</Text> Karma
              </Text>
            </View>
          </View>
        </View>
      </View>
      <View style={styles.tabContainer}>
        {["Posts", "Posts & replies", "Media", "Likes"].map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.activeTab]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlashList
        style={styles.container}
        data={posts}
        renderItem={({ item }) => <Post postData={item} />}
        keyExtractor={(item) => item.id}
      />
      <FileSelectorModal
        visible={isAvatarModalVisible}
        onClose={() => setIsAvatarModalVisible(false)}
        onSelect={handleAvatarSelect}
        options={{
          fileTypeFilter: ["image/"],
          maxFiles: 1
        }}
      />
      
      <FileSelectorModal
        visible={isCoverModalVisible}
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