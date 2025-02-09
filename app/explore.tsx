import { Link, Stack } from "expo-router";
import React, { useState, useEffect } from "react";
import {
  View,
  TextInput,
  StyleSheet,
  FlatList,
  ScrollView,
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
import { SafeAreaView } from "react-native-safe-area-context";

interface FilterChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

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
    // Safely check if post has content property
    const postContent = result.text || ''; // Assuming 'text' is the content field in your Post interface
    if (!filters.showImages && postContent.includes("image")) return false;
    if (!filters.showVideos && postContent.includes("video")) return false;
    if (!filters.showText && postContent.includes("text")) return false;
    return true;
  });

  const FilterChip: React.FC<FilterChipProps> = ({ label, active, onPress }) => (
    <TouchableOpacity 
      style={[styles.filterChip, active && styles.filterChipActive]} 
      onPress={onPress}
    >
      <ThemedText style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </ThemedText>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Header options={{ title: "Explore" }} />
      <View style={styles.searchContainer}>
        <Ionicons
          name="search"
          size={20}
          color="#666"
          style={styles.searchIcon}
        />
        <TextInput 
          placeholder={t("Search posts, people, and more...")} 
          style={styles.searchInput}
          placeholderTextColor="#666"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterChipsContainer}>
        <FilterChip 
          label={t("Images")} 
          active={filters.showImages} 
          onPress={() => handleFilterChange("showImages", !filters.showImages)} 
        />
        <FilterChip 
          label={t("Videos")} 
          active={filters.showVideos} 
          onPress={() => handleFilterChange("showVideos", !filters.showVideos)} 
        />
        <FilterChip 
          label={t("Text")} 
          active={filters.showText} 
          onPress={() => handleFilterChange("showText", !filters.showText)} 
        />
        {isPremium && (
          <>
            <FilterChip 
              label={t("Latest")} 
              active={advancedFilters.sortByDate} 
              onPress={() => handleAdvancedFilterChange({ filter: "sortByDate", value: !advancedFilters.sortByDate })} 
            />
            <FilterChip 
              label={t("Relevant")} 
              active={advancedFilters.sortByRelevance} 
              onPress={() => handleAdvancedFilterChange({ filter: "sortByRelevance", value: !advancedFilters.sortByRelevance })} 
            />
          </>
        )}
      </ScrollView>

      <Trends />
      
      <FlatList
        data={filteredResults}
        renderItem={({ item }) => <Post postData={item} />}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.postList}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    margin: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    height: '100%',
  },
  filterChipsContainer: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
    marginRight: 8,
  },
  filterChipActive: {
    backgroundColor: '#007AFF',
  },
  filterChipText: {
    fontSize: 14,
    color: '#666',
  },
  filterChipTextActive: {
    color: '#fff',
  },
  postList: {
    paddingHorizontal: 16,
  },
});
