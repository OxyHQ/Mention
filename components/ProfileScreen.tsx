import React, { useState } from "react";
import { useLocalSearchParams, Stack } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  FlatList,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { samplePosts } from "@/constants/sampleData";
import Post from "@/components/Post";
import { Header } from "@/components/Header";
import { colors } from "@/styles/colors";

export default function ProfileScreen({ username }: { username?: string }) {
  const { username: localUsername } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Posts");

  const user = {
    name: "John Doe",
    username: username || localUsername || "@nate",
    avatar: "https://mention.earth/_next/image?url=%2Fuser_placeholder.png&w=3840&q=75",
    bio: "React Native Developer | Coffee Enthusiast",
    location: "Barcelona, ES",
    website: "https://nateisern.com",
    joinDate: "Joined December 2012",
    following: 250,
    followers: 1000,
  };

  const renderHeader = () => (
    <View>
      <View style={{ padding: 15 }}>
        <Image
          source={{ uri: "https://cdn.bsky.app/img/banner/plain/did:plc:yvakileeq46vkx5vgodqgjef/bafkreicamq3qu4ibbadbkiuvh4qkw277he3wnky56zki3rrilryd6bkoaq@jpeg" }}
          style={styles.coverPhoto}
        />
        <View style={styles.profileInfo}>
          <Image source={{ uri: user.avatar }} style={styles.avatar} />
          <TouchableOpacity style={styles.editProfileButton}>
            <Text style={styles.editProfileButtonText}>Edit profile</Text>
          </TouchableOpacity>
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
          <View style={styles.followContainer}>
            <Text style={styles.followText}>
              <Text style={styles.followCount}>{user.following}</Text> Following
            </Text>
            <Text style={styles.followText}>
              <Text style={styles.followCount}>{user.followers}</Text> Followers
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
      <Header options={{
        title: user.name as string,
        subtitle: user.username,
        titlePosition: "center",
        leftComponents: [<Image source={{ uri: user.avatar }} style={styles.avatarHeader} />],
      }} />
      <FlatList
        style={styles.container}
        data={samplePosts}
        renderItem={({ item }) => <Post {...item} />}
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
    borderRadius: 37.5,
    borderWidth: 4,
    borderColor: "#fff",
    backgroundColor: "#ccc",
    marginTop: -40,
  },
  avatarHeader: {
    width: 40,
    height: 40,
    borderRadius: 37.5,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    backgroundColor: "#ccc",
  },
  editProfileButton: {
    position: "absolute",
    right: 15,
    top: 15,
    borderWidth: 1,
    borderColor: "#1DA1F2",
    borderRadius: 20,
    paddingVertical: 5,
    paddingHorizontal: 15,
  },
  editProfileButtonText: {
    color: "#1DA1F2",
    fontWeight: "bold",
  },
  name: {
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 10,
  },
  username: {
    color: "gray",
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
    color: "gray",
    marginLeft: 5,
  },
  link: {
    color: "#1DA1F2",
  },
  followContainer: {
    flexDirection: "row",
  },
  followText: {
    marginRight: 20,
  },
  followCount: {
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
    color: "gray",
  },
  activeTabText: {
    color: "#1DA1F2",
    fontWeight: "bold",
  },
});
