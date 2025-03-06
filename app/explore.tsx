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
import { Header } from '@/components/Header';
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { Trends } from "@/features/trends/Trends";
import { SafeAreaView } from "react-native-safe-area-context";
import Feed from "@/components/Feed";

interface FilterChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

const FilterChip: React.FC<FilterChipProps> = ({ label, active, onPress }) => (
  <TouchableOpacity
    onPress={onPress}
    className={`px-4 py-2 rounded-full mr-2 ${active ? 'bg-primary' : 'bg-gray-200'}`}
  >
    <ThemedText className={active ? 'text-white' : 'text-gray-700'}>
      {label}
    </ThemedText>
  </TouchableOpacity>
);

export default function ExploreScreen() {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("trending");

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Header options={{ title: t('Explore') }} />
      <View className="px-4 py-2">
        <View className="flex-row items-center bg-gray-100 rounded-full px-4 py-2">
          <Ionicons name="search" size={20} color="#666" />
          <TextInput
            className="flex-1 ml-2"
            placeholder={t('Search Mention')}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="px-4 py-2 flex-initial"
      >
        <FilterChip
          label={t('Trending')}
          active={activeFilter === 'trending'}
          onPress={() => setActiveFilter('trending')}
        />
        <FilterChip
          label={t('Latest')}
          active={activeFilter === 'latest'}
          onPress={() => setActiveFilter('latest')}
        />
        <FilterChip
          label={t('Media')}
          active={activeFilter === 'media'}
          onPress={() => setActiveFilter('media')}
        />
        <FilterChip
          label={t('People')}
          active={activeFilter === 'people'}
          onPress={() => setActiveFilter('people')}
        />
      </ScrollView>

      <View className="flex-1">
        {activeFilter === 'trending' && <Trends />}
        {(activeFilter === 'latest' || activeFilter === 'media') && (
          <Feed
            type="explore"
            showCreatePost={false}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    margin: 16,
    paddingHorizontal: 16,
    borderRadius: 35,
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
    paddingVertical: 8,
    marginBottom: 16,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 24,
    backgroundColor: '#F5F5F5',
    marginRight: 5,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  filterChipActive: {
    backgroundColor: '#2196F3',
    borderColor: '#1976D2',
  },
  filterChipPressed: {
    transform: [{ scale: 0.98 }],
    backgroundColor: '#EEEEEE',
  },
  filterChipText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#424242',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  postList: {
  },
});

