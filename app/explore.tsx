import { Link, Stack } from "expo-router";
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
import { Header } from '@/components/Header'
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { Trends } from "@/features/trends/Trends";
import { Post as PostInterface } from "@/interfaces/Post";

export default function SearchScreen() {
  const { t } = useTranslation();
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
  const posts: PostInterface[] = useSelector((state) => state.posts.posts);
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(fetchPosts());
  }, [dispatch]);

  interface Filters {
    showImages: boolean;
    showVideos: boolean;
    showText: boolean;
  }

  interface AdvancedFilters {
    sortByDate: boolean;
    sortByRelevance: boolean;
  }

  const handleFilterChange = (filter: keyof Filters, value: boolean) => {
    setFilters((prevFilters) => ({ ...prevFilters, [filter]: value }));
  };

  interface AdvancedFilterChange {
    filter: keyof AdvancedFilters;
    value: boolean;
  }

  const handleAdvancedFilterChange = ({ filter, value }: AdvancedFilterChange) => {
    setAdvancedFilters((prevFilters) => ({ ...prevFilters, [filter]: value }));
  };

  const filteredResults = posts.filter((result) => {
    if (!filters.showImages && result.content.includes("image")) return false;
    if (!filters.showVideos && result.content.includes("video")) return false;
    if (!filters.showText && result.content.includes("text")) return false;
    return true;
  });

  return (
    <>
      <Header options={{ title: "Explore" }} />
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
                  handleAdvancedFilterChange({ filter: "sortByDate", value })
                }
              />
            </View>
            <View style={styles.filterItem}>
              <ThemedText>{t("Sort by Relevance")}</ThemedText>
              <Switch
                value={advancedFilters.sortByRelevance}
                onValueChange={(value) =>
                  handleAdvancedFilterChange({ filter: "sortByRelevance", value })
                }
              />
            </View>
          </>
        )}
      </View>
      <Trends />
      <FlatList
        data={filteredResults}
        renderItem={({ item }) => (
          <Post
            postData={item}
          />
        )}
        keyExtractor={(item) => item.id}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    // ...existing code...
  },
  searchContainer: {
    // ...existing code...
  },
  searchIcon: {
    // ...existing code...
  },
  searchInput: {
    // ...existing code...
  },
});
