import React, { useState, useEffect } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, TextInput } from "react-native";
import { useLocalSearchParams } from 'expo-router';
import { fetchData } from "@/utils/api";
import { Loading } from "@/assets/icons/loading-icon";

interface SearchResult {
    id: string;
    title: string;
    description: string;
}

interface SearchResultsScreenProps {
    onSelectResult: (result: SearchResult) => void;
}

const SearchResultsScreen: React.FC<SearchResultsScreenProps> = ({ onSelectResult }) => {
    const { query } = useLocalSearchParams<{ query: string }>();
    const [searchText, setSearchText] = useState(query || "");
    const [results, setResults] = useState<SearchResult[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (query !== undefined) {
            setSearchText(query);
        }
    }, [query]);

    useEffect(() => {
        const fetchResults = async () => {
            try {
                setLoading(true);
                const data = await fetchData(`search?query=${encodeURIComponent(searchText)}`);
                setResults(data);
            } catch (error) {
                console.error("Error fetching search results:", error);
            } finally {
                setLoading(false);
            }
        };
        fetchResults();
    }, [searchText]);

    return (
        <View style={styles.container}>
            <View style={styles.searchBarContainer}>
                <TextInput
                    style={styles.searchBar}
                    value={searchText}
                    onChangeText={setSearchText}
                    placeholder="Search..."
                    returnKeyType="search"
                />
            </View>
            {loading ? (
                <View style={styles.loader}>
                    <Loading size={30} />
                </View>
            ) : results.length === 0 ? (
                <View style={styles.container}>
                    <Text>No results found for "{searchText}".</Text>
                </View>
            ) : (
                <FlatList
                    data={results}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <TouchableOpacity style={styles.itemContainer} onPress={() => onSelectResult(item)}>
                            <Text style={styles.title}>{item.title}</Text>
                            <Text style={styles.description}>{item.description}</Text>
                        </TouchableOpacity>
                    )}
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    searchBarContainer: {
        marginBottom: 10,
    },
    searchBar: {
        height: 40,
        borderColor: "#e1e8ed",
        borderWidth: 1,
        borderRadius: 20,
        paddingHorizontal: 15,
        backgroundColor: "#f5f8fa",
    },
    loader: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center"
    },
    itemContainer: {
        backgroundColor: "#fff",
        padding: 12,
        marginVertical: 6, // spacing between items
        borderRadius: 12, // rounded corners for a card feel
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 3,
        elevation: 2, // Android shadow
    },
    title: {
        fontSize: 18,
        fontWeight: "600", // bold text similar to Twitter
        color: "#14171A", // Twitter-like dark text color
        marginBottom: 4,
    },
    description: {
        fontSize: 14,
        color: "#657786"
    }
});

export default SearchResultsScreen;
