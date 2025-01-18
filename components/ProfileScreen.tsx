import React, { useState, useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  FlatList,
  Platform,
  ViewStyle,
} from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { colors } from "@/styles/colors";
import Avatar from "@/components/Avatar";
import { HandleIcon } from '@/assets/icons/handle-icon';
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { fetchProfile } from '@/store/reducers/profileReducer';
import { Chat as ChatIcon } from '@/assets/icons/chat-icon';

export default function ProfileScreen() {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");
  const posts = useSelector((state: { posts: { posts: any[] } }) => state.posts.posts);
  const profile = useSelector((state: { profile: { profile: any } }) => state.profile.profile);
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(fetchPosts());
    dispatch(fetchProfile({ username: localUsername.slice(1) }));
  }, [dispatch]);

  return (
    <>
      <View>
        <View style={{ padding: 15 }}>
          {router.canGoBack() && (
            <View style={styles.ProfileButtonBack}>
              <TouchableOpacity onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={20} color={colors.primaryColor} />
              </TouchableOpacity>
            </View>
          )}
          <Image
            source={{ uri: "https://cdn.bsky.app/img/banner/plain/did:plc:yvakileeq46vkx5vgodqgjef/bafkreicamq3qu4ibbadbkiuvh4qkw277he3wnky56zki3rrilryd6bkoaq@jpeg" }}
            style={styles.coverPhoto}
          />
          <View style={styles.profileInfo}>
            <Avatar source={profile?.avatar} style={styles.avatar} />
            <View style={styles.profileButtons}>
              <TouchableOpacity style={styles.ProfileButton}>
                <ChatIcon size={20} color={colors.primaryColor} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.ProfileButton}>
                <Text style={styles.ProfileButtonText}>Edit profile</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ProfileButton}>
                <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
              </TouchableOpacity>
            </View>
            <Text style={styles.name}>{profile?.name?.first} {profile?.name?.last}</Text>
            <Text style={styles.username}>@{profile?.username}</Text>
            {profile?.bio && (
              <Text style={styles.bio}>{profile?.bio}</Text>
            )}
            <View style={styles.userDetails}>
              {profile?.location && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="location-outline" size={16} color="gray" />
                  <Text style={styles.userDetailText}>{profile?.location}</Text>
                </View>
              )}
              {profile?.website && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="link-outline" size={16} color="gray" />
                  <Text style={[styles.userDetailText, styles.link]}>
                    {profile.website}
                  </Text>
                </View>
              )}
              {profile?.joinDate && (
                <View style={styles.userDetailItem}>
                  <Ionicons name="calendar-outline" size={16} color="gray" />
                  <Text style={styles.userDetailText}>{profile?.joinDate}</Text>
                </View>
              )}
            </View>
            <View style={styles.statsContainer}>
              <Link href={`/@${profile?.username}/following`} style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.following}</Text> Following
              </Link>
              <Link href={`/@${profile?.username}/followers`} style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.followers}</Text> Followers
              </Link>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.posts}</Text> Posts
              </Text>
              <Text style={styles.statText}>
                <Text style={styles.statCount}>{profile?._count?.karma}</Text> Karma
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
            <Text
              style={[
                styles.tabText,
                activeTab === tab && styles.activeTabText,
              ]}
            >
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
    </>
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
