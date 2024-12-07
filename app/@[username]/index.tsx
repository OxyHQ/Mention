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
import { sampleTweets } from "@/constants/sampleData";
import Tweet from "@/components/Tweet";

export default function ProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const [activeTab, setActiveTab] = useState("Tweets");

  const user = {
    name: "John Doe",
    username: username || "@johndoe",
    avatar: "https://via.placeholder.com/100",
    bio: "React Native Developer | Coffee Enthusiast",
    location: "San Francisco, CA",
    website: "https://johndoe.dev",
    joinDate: "Joined September 2010",
    following: 250,
    followers: 1000,
  };

  const renderHeader = () => (
    <View>
      <Image
        source={{ uri: "https://via.placeholder.com/500x150" }}
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
      <View style={styles.tabContainer}>
        {["Tweets", "Tweets & replies", "Media", "Likes"].map((tab) => (
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
      <Stack.Screen options={{ title: username as string }} />
      <FlatList
        style={styles.container}
        data={sampleTweets}
        renderItem={({ item }) => <Tweet {...item} />}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={renderHeader}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  coverPhoto: {
    width: "100%",
    height: 150,
  },
  profileInfo: {
    padding: 15,
  },
  avatar: {
    width: 75,
    height: 75,
    borderRadius: 37.5,
    borderWidth: 4,
    borderColor: "#fff",
    marginTop: -40,
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
