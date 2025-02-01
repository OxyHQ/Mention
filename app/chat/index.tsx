import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, TextInput, ScrollView } from "react-native";
import { Stack, useLocalSearchParams, router, Link } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { Header } from '@/components/Header'
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

const messages = [
    {
        id: "1",
        user: {
            name: "Jane Smith",
            avatar: "https://via.placeholder.com/50",
        },
        content: "Hey, how are you?",
        timestamp: "2h ago",
    },
    {
        id: "2",
        user: {
            name: "Bob Johnson",
            avatar: "https://via.placeholder.com/50",
        },
        content: "Let's catch up soon!",
        timestamp: "4h ago",
    },
    // Add more messages
];

const stories = [
    {
        id: "1",
        user: {
            name: "Alice",
            avatar: "https://via.placeholder.com/50",
        },
    },
    {
        id: "2",
        user: {
            name: "Bob",
            avatar: "https://via.placeholder.com/50",
        },
    },
    {
        id: "3",
        user: {
            name: "Charlie",
            avatar: "https://via.placeholder.com/50",
        },
    },

];

type Message = {
    id: string;
    user: {
        name: string;
        avatar: string;
    };
    content: string;
    timestamp: string;
};

const MessageItem = ({ message }: { message: Message }) => (
    <Link href={`/chat/c/${message.user.name}`} style={styles.messageContainer}>
        <Image source={{ uri: message.user.avatar }} style={styles.avatar} />
        <View style={styles.messageContent}>
            <View style={styles.messageHeader}>
                <ThemedText style={styles.userName}>{message.user.name}</ThemedText>
                <ThemedText style={styles.timestamp}>{message.timestamp}</ThemedText>
            </View>
            <ThemedText style={styles.messageText} numberOfLines={1}>{message.content}</ThemedText>
        </View>
    </Link>
);

const StoryItem = ({ story }: { story: { id: string; user: { name: string; avatar: string } } }) => (
    <View style={styles.storyContainer}>
        <Image source={{ uri: story.user.avatar }} style={styles.storyAvatar} />
        <ThemedText style={styles.storyUserName}>{story.user.name}</ThemedText>
    </View>
);

const StoriesList = () => (
    <FlatList
        data={stories}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <StoryItem story={item} />}
        contentContainerStyle={styles.storiesContainer}
    />
);

export default function MessagesScreen() {
    const { t } = useTranslation();
    const [searchQuery, setSearchQuery] = useState("");

    const filteredMessages = messages.filter((message) =>
        message.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        message.content.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <SafeAreaView>
            <Header options={{
                title: "Chat",
                titlePosition: "center",
                leftComponents: [
                    <TouchableOpacity key="new-chat" onPress={() => { /* Add new chat functionality */ }}>
                        <Ionicons name="create-outline" size={26} color="black" />
                    </TouchableOpacity>],
                rightComponents: [
                    <TouchableOpacity key="settings" onPress={() => { /* Add settings functionality */ }}>
                        <Ionicons name="settings-outline" size={26} color="black" />
                    </TouchableOpacity>
                ]
            }} />
            <StoriesList />
            <TextInput
                style={styles.searchBar}
                placeholder={t("Search")}
                value={searchQuery}
                onChangeText={setSearchQuery}
            />
            <FlatList
                data={filteredMessages}
                renderItem={({ item }) => <MessageItem message={item} />}
                keyExtractor={(item) => item.id}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    searchBar: {
        height: 40,
        borderColor: "#e1e8ed",
        borderWidth: 1,
        borderRadius: 20,
        paddingHorizontal: 15,
        margin: 10,
    },
    storiesContainer: {
        display: "flex",
        flexDirection: "row",
        paddingVertical: 10,
        paddingHorizontal: 5,
        borderBottomWidth: 1,
        borderBottomColor: "#e1e8ed",
    },
    storyContainer: {
        alignItems: "center",
        marginHorizontal: 10,
    },
    storyAvatar: {
        width: 60,
        height: 60,
        borderRadius: 30,
        marginBottom: 5,
    },
    storyUserName: {
        fontSize: 12,
    },
    messageContainer: {
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
    messageContent: {
        flex: 1,
        justifyContent: "center",
    },
    messageHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
    },
    userName: {
        fontWeight: "bold",
        fontSize: 16,
    },
    messageText: {
        fontSize: 16,
        color: "#333",
    },
    timestamp: {
        color: "gray",
    },
});
