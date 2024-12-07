import { FlatList, RefreshControl, StyleSheet } from "react-native";
import React, { useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import Tweet from "@/components/Tweet";
import { ThemedView } from "@/components/ThemedView";
import { useColorScheme } from "@/hooks/useColorScheme";
import { sampleTweets } from "@/constants/sampleData";

export default function HomeScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const colorScheme = useColorScheme();

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 2000);
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "Home" }} />
      <ThemedView style={styles.container}>
        <FlatList
          data={sampleTweets}
          renderItem={({ item }) => <Tweet {...item} />}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
