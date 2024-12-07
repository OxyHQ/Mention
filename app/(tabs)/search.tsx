import React from "react";
import { View, TextInput, StyleSheet, FlatList, Image } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";

const searchResults = [
  {
    id: "1",
    user: {
      name: "Jane Smith",
      avatar: "https://via.placeholder.com/50",
    },
    content: "This is a sample tweet",
    timestamp: "2h ago",
  },
  {
    id: "2",
    user: {
      name: "Bob Johnson",
      avatar: "https://via.placeholder.com/50",
    },
    content: "Another example tweet",
    timestamp: "4h ago",
  },
  // Add more search results
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

export default function SearchScreen() {
  const { t } = useTranslation();

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.header}>
        <ThemedText style={styles.headerTitle}>{t("Search")}</ThemedText>
      </ThemedView>
      <TextInput placeholder={t("Search")} style={styles.searchInput} />
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
  searchInput: {
    borderColor: "#ccc",
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginVertical: 16,
  },
  resultContainer: {
    flexDirection: "row",
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
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
  },
  timestamp: {
    color: "gray",
    marginTop: 5,
  },
});
