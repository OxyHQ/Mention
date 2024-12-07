import React, { useState, useCallback } from "react";
import { useLocalSearchParams, Stack, Tabs } from "expo-router";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  FlatList,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { sampleTweets } from "@/constants/sampleData";
import Tweet from "@/components/Tweet";
import Animated, {
  useAnimatedStyle,
  withTiming,
  Easing,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

export default function ProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const user = {
    avatar: "https://via.placeholder.com/75",
    name: "John Doe",
    username: "@johndoe",
    bio: "This is a sample bio",
    location: "Earth",
    website: "https://example.com",
    joinDate: "Joined January 2021",
    following: 100,
    followers: 200,
  };
  const [activeTab, setActiveTab] = useState("tweets");

  const filteredTweets = useCallback(() => {
    switch (activeTab) {
      case "replies":
        return sampleTweets.filter((tweet) => tweet.isReply);
      case "media":
        return sampleTweets.filter((tweet) => tweet.hasMedia);
      case "likes":
        return sampleTweets.filter((tweet) => tweet.isLiked);
      default:
        return sampleTweets.filter((tweet) => !tweet.isReply);
    }
  }, [activeTab]);

  const handleTabPress = (tab: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveTab(tab);
  };

  const TabButton = ({
    label,
    isActive,
    onPress,
  }: {
    label: string;
    isActive: boolean;
    onPress: () => void;
  }) => {
    const animatedStyles = useAnimatedStyle(() => ({
      borderBottomWidth: withTiming(isActive ? 2 : 0, {
        duration: 200,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      }),
      opacity: withTiming(isActive ? 1 : 0.7, {
        duration: 150,
      }),
    }));

    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.8 : 1 }]}
      >
        <Animated.View style={[styles.tabContent, animatedStyles]}>
          <Text style={[styles.tabText, isActive && styles.activeTabText]}>
            {label}
          </Text>
        </Animated.View>
      </Pressable>
    );
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
        <TabButton
          label="Tweets"
          isActive={activeTab === "tweets"}
          onPress={() => handleTabPress("tweets")}
        />
        <TabButton
          label="Replies"
          isActive={activeTab === "replies"}
          onPress={() => handleTabPress("replies")}
        />
        <TabButton
          label="Media"
          isActive={activeTab === "media"}
          onPress={() => handleTabPress("media")}
        />
        <TabButton
          label="Likes"
          isActive={activeTab === "likes"}
          onPress={() => handleTabPress("likes")}
        />
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: username as string }} />
      <Tabs.Screen options={{ headerShown: false }} />
      <FlatList
        style={styles.container}
        data={filteredTweets()}
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e1e8ed",
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
  },
  tabContent: {
    alignItems: "center",
    borderBottomColor: "#1DA1F2",
    paddingBottom: 8,
  },
  tabText: {
    fontSize: 14,
    color: "#536471",
  },
  activeTabText: {
    color: "#1DA1F2",
    fontWeight: "600",
  },
});
