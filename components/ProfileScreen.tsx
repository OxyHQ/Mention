import React, { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  FlatList,
} from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { colors } from "@/styles/colors";
import { useFetchPosts } from "@/hooks/useFetchPosts";
import Avatar from "@/components/Avatar";

export default function ProfileScreen({ username }: { username?: string }) {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");
  const posts = useFetchPosts();

  const user = {
    name: "Nate Isern",
    username: username,
    avatar: "https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857",
    bio: "React Native Developer | Coffee Enthusiast",
    location: "Barcelona, ES",
    website: "https://nateisern.com",
    joinDate: "Joined December 2012",
    _count: {
      following: 250,
      followers: 1000,
      posts: 100,
      karma: 500,
    },
  };

  const renderHeader = () => (
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
          <Avatar source={user.avatar} style={styles.avatar} />
          <View style={styles.profileButtons}>
            <TouchableOpacity style={styles.ProfileButton}>
              <Text style={styles.ProfileButtonText}>Edit profile</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.ProfileButton}>
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
            </TouchableOpacity>
          </View>
          <Text style={styles.name}>{user.name}</Text>
          <Text style={styles.username}>{user.username}</Text>
          <Text style={styles.bio}>{user.bio}</Text>
          <View style={styles.userDetails}>
            <View style={styles.userDetailItem}>
              <Ionicons name="location-outline" size={16} color="gray" />
              <Text style={styles.userDetailText}>{user.location}</Text>
            </View>
            <View style={styles.userDetailItem}>
              <Ionicons name="link-outline" size={16} color="gray" />
              <Text style={[styles.userDetailText, styles.link]}>
                {user.website}
              </Text>
            </View>
            <View style={styles.userDetailItem}>
              <Ionicons name="calendar-outline" size={16} color="gray" />
              <Text style={styles.userDetailText}>{user.joinDate}</Text>
            </View>
          </View>
          <View style={styles.statsContainer}>
            <Link href="/following" style={styles.statText}>
              <Text style={styles.statCount}>{user._count.following}</Text> Following
            </Link>
            <Link href="/followers" style={styles.statText}>
              <Text style={styles.statCount}>{user._count.followers}</Text> Followers
            </Link>
            <Text style={styles.statText}>
              <Text style={styles.statCount}>{user._count.posts}</Text> Posts
            </Text>
            <Text style={styles.statText}>
              <Text style={styles.statCount}>{user._count.karma}</Text> Karma
            </Text>
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
    </View>
  );

  return (
    <>
      <FlatList
        style={styles.container}
        data={posts}
        renderItem={({ item }) => <Post postData={item} />}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderHeader}
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
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 15,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: "#1DA1F2",
  },
  tabText: {
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  activeTabText: {
    color: "#1DA1F2",
    fontWeight: "bold",
  },
});
