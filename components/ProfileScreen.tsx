import React, { useEffect, useState } from 'react';
import { View, Image, FlatList, TouchableOpacity, Text, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams, Link } from "expo-router";
import { StyleSheet, Platform, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { colors } from "@/styles/colors";
import Avatar from "@/components/Avatar";
import { Chat as ChatIcon } from '@/assets/icons/chat-icon';
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { fetchProfile } from '@/store/reducers/profileReducer';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ProfileScreen() {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");
  const dispatch = useDispatch();
  const { profile, loading, error } = useSelector((state: any) => state.profile);
  const posts = useSelector((state: { posts: { posts: any[] } }) => state.posts.posts);

  useEffect(() => {
    if (localUsername) {
      dispatch(fetchProfile({ username: localUsername }));
    }
    dispatch(fetchPosts());
  }, [dispatch, localUsername]);

  const displayUser = profile; // Use profile fetched from the server
  
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
          {displayUser?.banner ? (
            <Image source={{ uri: displayUser.banner }} style={styles.coverPhoto} />
          ) : (
            <View style={[styles.coverPhoto, { backgroundColor: '#ccc' }]} />
          )}
          
          <View style={styles.profileInfo}>
          <Avatar style={styles.avatar} />
            <View style={styles.profileButtons}>
              <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                console.log("Chat button pressed");
              }}>
                <ChatIcon size={20} color={colors.primaryColor} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                router.push('/settings/profile/edit');
              }}>
                <Text style={styles.ProfileButtonText}>Edit profile</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ProfileButton} onPress={() => {
                console.log("More options button pressed");
              }}>
                <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
              </TouchableOpacity>
            </View>
            <Text style={styles.name}>
              {displayUser && displayUser.name?.first ? `${displayUser.name.first} ${displayUser.name.last}` : localUsername?.replace('@', '')}
            </Text>
            <Text style={styles.username}>@{displayUser ? displayUser.username : localUsername?.replace('@', '')}</Text>
            {displayUser?.description && (
              <Text style={styles.bio}>{displayUser.description}</Text>
            )}
            <View style={styles.userDetails}>
              {displayUser?.location && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="location-outline" size={16} color="gray" />
                  <Text style={styles.userDetailText}>{displayUser.location}</Text>
                </View>
              )}
              {displayUser?.website && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="link-outline" size={16} color="gray" />
                  <Text style={[styles.userDetailText, styles.link]}>
                    {displayUser.website}
                  </Text>
                </View>
              )}
              {displayUser?.joinDate && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="calendar-outline" size={16} color="gray" />
                  <Text style={styles.userDetailText}>{displayUser.joinDate}</Text>
                </View>
              )}
            </View>
            <View style={styles.statsContainer}>
              <Link href={`/@${displayUser?.username || localUsername?.replace('@', '')}`} style={styles.statText}>
                <Text style={styles.statCount}>{displayUser?._count?.following || 0}</Text> Following
              </Link>
              <Link href={`/@${displayUser?.username || localUsername?.replace('@', '')}/followers`} style={styles.statText}>
                <Text style={styles.statCount}>{displayUser?._count?.followers || 0}</Text> Followers
              </Link>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{displayUser?._count?.posts || 0}</Text> Posts
              </Text>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{displayUser?._count?.karma || 0}</Text> Karma
              </Text>
            </View>
            {loading && <ActivityIndicator size="small" color={colors.primaryColor} />}
            {error && <Text style={{color: 'red'}}>{error}</Text>}
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
      <FlatList
        style={styles.container}
        data={posts}
        renderItem={({ item }) => <Post postData={item} />}
        keyExtractor={(item) => item.id}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  coverPhoto: {
    width: "100%",
    height: 150,
    borderRadius: 35,
  },
  profileInfo: {
  },
  avatar: {
    width: 75,
    height: 75,
    borderWidth: 4,
    marginTop: -40,
    borderColor: colors.primaryLight,
  },
  profileButtons: {
    position: "absolute",
    right: 15,
    top: 15,
    flexDirection: "row",
    gap: 10,
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
  username: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_3,
    marginBottom: 10,
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
});
