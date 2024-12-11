import { Stack, useLocalSearchParams } from "expo-router";
import React, { useState, useEffect } from "react";
import {
  View,
  TextInput,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  Switch,
} from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { fetchData } from "@/utils/api";
import { storeData, getData } from "@/utils/storage";
import { sampleTrends } from "@/constants/sampleData";

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

const trends = sampleTrends.map((trend, index) => ({
  id: (index + 1).toString(),
  topic: trend.hashtag,
  countTotal: trend.count.toString(),
}));

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
  countTotal: string;
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

const TrendItem = ({
  trend,
  onPress,
}: {
  trend: Trend;
  onPress: () => void;
}) => (
  <TouchableOpacity style={styles.trendContainer} onPress={onPress}>
    <ThemedText style={styles.trendTopic}>{trend.topic}</ThemedText>
    <ThemedText style={styles.trendcountTotal}>
      {trend.countTotal} Posts
    </ThemedText>
  </TouchableOpacity>
);

const renderPost = ({ item }: { item: SearchResult }) => (
  <SearchResultItem result={item} />
);

type PostAPIResponse = {
  id: string;
  text: string;
  created_at: string;
  author: {
    name: string;
    image: string;
  };
};

const fetchPosts = async () => {
  try {
    const response = await fetchData("posts");
    const posts = response.posts.map((post: PostAPIResponse) => ({
      id: post.id,
      user: {
        name: post.author?.name || "Unknown",
        avatar: post.author?.image || "https://via.placeholder.com/50",
      },
      content: decodeURIComponent(post.text),
      timestamp: new Date(post.created_at).toLocaleTimeString(),
    }));
    console.log("Fetched posts:", posts);
    return posts;
  } catch (error) {
    console.error("Error fetching posts:", error);
    return [];
  }
};

export default function SearchScreen() {
  const { t } = useTranslation();
  const [selectedHashtag, setSelectedHashtag] = useState<string | null>(null);
  const [isPremium, setIsPremium] = useState(false);
  const [filters, setFilters] = useState({
    showImages: true,
    showVideos: true,
    showText: true,
  });
  const [advancedFilters, setAdvancedFilters] = useState({
    sortByDate: false,
    sortByRelevance: false,
  });
  const [trends, setTrends] = useState<Trend[]>([]);
  const [posts, setPosts] = useState<SearchResult[]>([]);

  const handleHashtagPress = (hashtag: string) => {
    setSelectedHashtag(hashtag);
  };

  const handleFilterChange = (filter: string, value: boolean) => {
    setFilters((prevFilters) => ({ ...prevFilters, [filter]: value }));
  };

  const handleAdvancedFilterChange = (filter: string, value: boolean) => {
    setAdvancedFilters((prevFilters) => ({ ...prevFilters, [filter]: value }));
  };

  const filteredResults = posts.filter((result) => {
    if (!filters.showImages && result.content.includes("image")) return false;
    if (!filters.showVideos && result.content.includes("video")) return false;
    if (!filters.showText && result.content.includes("text")) return false;
    return true;
  });

  const retrieveTrendsFromAPI = async () => {
    try {
      const data = await fetchData("trends");
      if (data) {
        await storeData("trends", data);
        setTrends(data);
      } else {
        console.warn("No trends data returned from API");
      }
    } catch (error) {
      console.error("Error retrieving trends from API:", error);
    }
  };

  useEffect(() => {
    const fetchTrends = async () => {
      const storedTrends = await getData("trends");
      if (storedTrends) {
        setTrends(storedTrends);
      } else {
        retrieveTrendsFromAPI();
      }
    };

    fetchTrends();
  }, []);

  useEffect(() => {
    const fetchAndSetPosts = async () => {
      const fetchedPosts = await fetchPosts();
      setPosts(fetchedPosts);
    };

    fetchAndSetPosts();
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "Search" }} />
      <ThemedView style={styles.container}>
        <View style={styles.searchContainer}>
          <Ionicons
            name="search"
            size={20}
            color="#ccc"
            style={styles.searchIcon}
          />
          <TextInput placeholder={t("Explore")} style={styles.searchInput} />
        </View>
        <View style={styles.filtersContainer}>
          <ThemedText>{t("Filters")}</ThemedText>
          <View style={styles.filterItem}>
            <ThemedText>{t("Show Images")}</ThemedText>
            <Switch
              value={filters.showImages}
              onValueChange={(value) => handleFilterChange("showImages", value)}
            />
          </View>
          <View style={styles.filterItem}>
            <ThemedText>{t("Show Videos")}</ThemedText>
            <Switch
              value={filters.showVideos}
              onValueChange={(value) => handleFilterChange("showVideos", value)}
            />
          </View>
          <View style={styles.filterItem}>
            <ThemedText>{t("Show Text")}</ThemedText>
            <Switch
              value={filters.showText}
              onValueChange={(value) => handleFilterChange("showText", value)}
            />
          </View>
          {isPremium && (
            <>
              <ThemedText>{t("Advanced Filters")}</ThemedText>
              <View style={styles.filterItem}>
                <ThemedText>{t("Sort by Date")}</ThemedText>
                <Switch
                  value={advancedFilters.sortByDate}
                  onValueChange={(value) =>
                    handleAdvancedFilterChange("sortByDate", value)
                  }
                />
              </View>
              <View style={styles.filterItem}>
                <ThemedText>{t("Sort by Relevance")}</ThemedText>
                <Switch
                  value={advancedFilters.sortByRelevance}
                  onValueChange={(value) =>
                    handleAdvancedFilterChange("sortByRelevance", value)
                  }
                />
              </View>
            </>
          )}
        </View>
        <FlatList
          data={trends}
          renderItem={({ item }) => (
            <TrendItem
              trend={item}
              onPress={() => handleHashtagPress(item.topic)}
            />
          )}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={<ThemedText style={styles.trendsHeader}>
            {t("Trends for you")}
          </ThemedText>}
          style={styles.trendsList}
        />
        <FlatList
          data={filteredResults}
          renderItem={({ item }) => (
            <Post
              id={item.id}
              avatar={item.user.avatar}
              name={item.user.name}
              username={item.user.name} // Assuming username is the same as name
              time={item.timestamp}
              content={item.content}
              likes={0} // Assuming default value
              reposts={0} // Assuming default value
              replies={0} // Assuming default value
            />
          )}
          keyExtractor={(item) => item.id}
        />
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {

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
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  trendTopic: {
    fontSize: 16,
    fontWeight: "bold",
  },
  trendcountTotal: {
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
    width: "100%",
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
  filtersContainer: {
    marginVertical: 16,
  },
  filterItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginVertical: 8,
  },
});
