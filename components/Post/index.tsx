import React, { useState } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from 'expo-sharing';
import { Post as PostType } from "@/constants/sampleData";
import { Image as RNImage } from "react-native";
import { detectHashtags } from "./utils";
import { renderImages, renderPoll, renderLocation } from "./renderers";

export default function Post({
    id,
    avatar,
    name,
    username,
    content,
    time,
    likes = 0,
    reposts = 0,
    replies = 0,
    images = [],
    poll,
    location,
}: PostType) {
    const [isLiked, setIsLiked] = useState(false);
    const [likesCount, setLikesCount] = useState(likes);
    const [isBookmarked, setIsBookmarked] = useState(false);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);

    const handleLike = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsLiked(!isLiked);
        setLikesCount((prev) => (isLiked ? prev - 1 : prev + 1));
    };

    const handleShare = async (event: any) => {
        event.stopPropagation();
        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(`https://mention.earth/post/${id}`, {
                dialogTitle: 'Share Post',
                mimeType: 'text/plain',
            });
        } else {
            alert("Sharing is not available on this device");
        }
    };

    const handleBookmark = (event: any) => {
        event.stopPropagation();
        setIsBookmarked(!isBookmarked);
    };

    const handlePollOptionPress = (index: number) => {
        setSelectedOption(index);
    };

    return (
        <>
            <Link href={`/post/${id}`} asChild>
                <TouchableOpacity>
                    <View style={styles.container}>
                        <Image source={{ uri: avatar }} style={styles.avatar} />
                        <View style={styles.contentContainer}>
                            <View style={styles.header}>
                                <Text style={styles.name}>{name}</Text>
                                <Text style={styles.username}>{username}</Text>
                                <Text style={styles.time}>· {time}</Text>
                            </View>
                            <Text style={styles.content}>{detectHashtags(content)}</Text>
                            {renderImages(images)}
                            {renderPoll(poll, selectedOption, handlePollOptionPress)}
                            {renderLocation(location)}
                            <View style={styles.actions}>
                                <View style={styles.actionItem}>
                                    <Ionicons name="chatbubble-outline" size={20} color="#536471" />
                                    <Text style={styles.actionText}>{replies}</Text>
                                </View>
                                <View style={styles.actionItem}>
                                    <Ionicons name="repeat-outline" size={20} color="#536471" />
                                    <Text style={styles.actionText}>{reposts}</Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleLike(event);
                                    }}
                                >
                                    <Ionicons
                                        name={isLiked ? "heart" : "heart-outline"}
                                        size={20}
                                        color={isLiked ? "#F91880" : "#536471"}
                                    />
                                    <Text style={[styles.actionText, isLiked && styles.likedText]}>
                                        {likesCount}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleShare(event);
                                    }}
                                >
                                    <Ionicons name="share-outline" size={20} color="#536471" />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleBookmark(event);
                                    }}
                                >
                                    <Ionicons
                                        name={isBookmarked ? "bookmark" : "bookmark-outline"}
                                        size={20}
                                        color={isBookmarked ? "#1DA1F2" : "#536471"}
                                    />
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </TouchableOpacity>
            </Link>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: "row",
        padding: 12,
        borderBottomColor: "#e1e8ed",
        borderBottomWidth: 1,
    },
    avatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
    },
    contentContainer: {
        flex: 1,
        marginLeft: 12,
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
    },
    name: {
        fontWeight: "bold",
        marginRight: 4,
    },
    username: {
        color: "#536471",
    },
    time: {
        color: "#536471",
        marginLeft: 4,
    },
    content: {
        marginTop: 4,
        lineHeight: 20,
    },
    actions: {
        flexDirection: "row",
        marginTop: 12,
        justifyContent: "space-between",
        maxWidth: 300,
    },
    actionItem: {
        flexDirection: "row",
        alignItems: "center",
        marginRight: 16, // Add margin to separate action items
    },
    actionText: {
        color: "#536471",
        fontSize: 13,
        marginLeft: 4,
    },
    likedText: {
        color: "#F91880",
    },
});
