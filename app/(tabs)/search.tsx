import React from "react";
import {
  View,
  TextInput,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
} from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";

const searchResults = [
  {
    id: "1",
    user: {
      name: "Jane Smith",
      avatar: "https://via.placeholder.com/50",
    },
    content: "This is a sample post",
    timestamp: "2h ago",
  },
  {
    id: "2",
    user: {
      name: "Bob Johnson",
      avatar: "https://via.placeholder.com/50",
    },
    content: "Another example post",
    timestamp: "4h ago",
  },
  // Add more search results
];

const trends = [
  { id: "1", topic: "#ReactNative", tweets: "120K Tweets" },
  { id: "2", topic: "#JavaScript", tweets: "80K Tweets" },
  // Add more trends
];

type SearchResult = {
  id: string;
  user: {
    name: string;
    avatar: string;
  };
  content: string;
  timestamp: string;
};

type Trend = {
  id: string;
  topic: string;
  tweets: string;
};

const SearchResultItem = ({ result }: { result: SearchResult }) => (
  <View style={styles.resultContainer}>
    <Image source={{ uri: result.user.avatar }} style={styles.avatar} />
    <View style={styles.resultContent}>
      <ThemedText style={styles.userName}>{result.user.name}</ThemedText>
      <ThemedText style={styles.resultText}>{result.content}</ThemedText>
      <ThemedText style={styles.timestamp}>{result.timestamp}</ThemedText>
    </View>
  </View>
);

const TrendItem = ({ trend }: { trend: Trend }) => (
  <View style={styles.trendContainer}>
    <ThemedText style={styles.trendTopic}>{trend.topic}</ThemedText>
    <ThemedText style={styles.trendTweets}>{trend.tweets}</ThemedText>
  </View>
);

export default function SearchScreen() {
  const { t } = useTranslation();

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.header}>
        <ThemedText style={styles.headerTitle}>{t("Explore")}</ThemedText>
      </ThemedView>
      <View style={styles.searchContainer}>
        <Ionicons
          name="search"
          size={20}
          color="#ccc"
          style={styles.searchIcon}
        />
        <TextInput placeholder={t("Explore")} style={styles.searchInput} />
      </View>
      <FlatList
        data={trends}
        renderItem={({ item }) => <TrendItem trend={item} />}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <ThemedText style={styles.trendsHeader}>
            {t("Trends for you")}
          </ThemedText>
        }
        style={styles.trendsList}
      />
      <FlatList
        data={searchResults}
        renderItem={({ item }) => <SearchResultItem result={item} />}
        keyExtractor={(item) => item.id}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderColor: "#ccc",
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginVertical: 16,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
  },
  trendsHeader: {
    fontSize: 18,
    fontWeight: "bold",
    marginVertical: 8,
  },
  trendsList: {
    marginBottom: 16,
  },
  trendContainer: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  trendTopic: {
    fontSize: 16,
    fontWeight: "bold",
  },
  trendTweets: {
    color: "gray",
  },
  resultContainer: {
    flexDirection: "row",
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
    alignItems: "center",
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    marginRight: 10,
  },
  resultContent: {
    flex: 1,
  },
  userName: {
    fontWeight: "bold",
  },
  resultText: {
    fontSize: 16,
    marginTop: 4,
  },
  timestamp: {
    color: "gray",
    marginTop: 5,
  },
});
