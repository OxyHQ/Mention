import React, { useState, useRef } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity, Animated, Easing, Share } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from 'expo-sharing';
import { Post as PostType } from "@/constants/sampleData";
import { Image as RNImage } from "react-native";
import { detectHashtags } from "./utils";
import { renderImages, renderPoll, renderLocation } from "./renderers";
import AnimatedNumbers from 'react-native-animated-numbers';

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
    const [isReposted, setIsReposted] = useState(false);
    const [repostsCount, setRepostsCount] = useState(reposts);
    const [bookmarksCount, setBookmarksCount] = useState(0);
    const [repliesCount, setRepliesCount] = useState(replies);

    const animatedScale = useRef(new Animated.Value(1)).current;
    const animatedOpacity = useRef(new Animated.Value(1)).current;
    const animatedLikesCount = useRef(new Animated.Value(likes)).current;
    const animatedRepostsCount = useRef(new Animated.Value(reposts)).current;
    const animatedBookmarksCount = useRef(new Animated.Value(0)).current;
    const animatedRepliesCount = useRef(new Animated.Value(replies)).current;

    const scaleAnimation = () => {
        Animated.sequence([
            Animated.timing(animatedScale, {
                toValue: 1.2,
                duration: 150,
                easing: Easing.ease,
                useNativeDriver: true,
            }),
            Animated.timing(animatedScale, {
                toValue: 1,
                duration: 150,
                easing: Easing.ease,
                useNativeDriver: true,
            }),
        ]).start();
    };

    const fadeAnimation = () => {
        Animated.sequence([
            Animated.timing(animatedOpacity, {
                toValue: 0,
                duration: 150,
                easing: Easing.ease,
                useNativeDriver: true,
            }),
            Animated.timing(animatedOpacity, {
                toValue: 1,
                duration: 150,
                easing: Easing.ease,
                useNativeDriver: true,
            }),
        ]).start();
    };

    const handleLike = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsLiked(!isLiked);
        const newLikesCount = isLiked ? likesCount - 1 : likesCount + 1;
        setLikesCount(newLikesCount);
        Animated.timing(animatedLikesCount, {
            toValue: newLikesCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: false,
        }).start();
        scaleAnimation();
        fadeAnimation();
    };

    const handleShare = async (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            await Share.share({
                message: `Check out this post: https://mention.earth/post/${id}`,
                title: 'Share Post',
            });
        } catch (error) {
            if (error instanceof Error) {
                alert("Error sharing post: " + error.message);
            } else {
                alert("Error sharing post");
            }
        }
    };

    const handleBookmark = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsBookmarked(!isBookmarked);
        const newBookmarksCount = isBookmarked ? bookmarksCount - 1 : bookmarksCount + 1;
        setBookmarksCount(newBookmarksCount);
        Animated.timing(animatedBookmarksCount, {
            toValue: newBookmarksCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: false,
        }).start();
    };

    const handleRepost = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsReposted(!isReposted);
        const newRepostsCount = isReposted ? repostsCount - 1 : repostsCount + 1;
        setRepostsCount(newRepostsCount);
        Animated.timing(animatedRepostsCount, {
            toValue: newRepostsCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: false,
        }).start();
    };

    const handleReply = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        const newRepliesCount = repliesCount + 1; // Assuming a reply is added
        setRepliesCount(newRepliesCount);
        Animated.timing(animatedRepliesCount, {
            toValue: newRepliesCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: false,
        }).start();
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
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleReply(event);
                                    }}
                                >
                                    <Ionicons name="chatbubble-outline" size={20} color="#536471" />
                                    <AnimatedNumbers
                                        includeComma
                                        animateToNumber={repliesCount}
                                        animationDuration={300}
                                        fontStyle={{ color: "#536471" }}
                                    />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleRepost(event);
                                    }}
                                >
                                    <Ionicons
                                        name={isReposted ? "repeat" : "repeat-outline"}
                                        size={20}
                                        color={isReposted ? "#1DA1F2" : "#536471"}
                                    />
                                    <AnimatedNumbers
                                        includeComma
                                        animateToNumber={repostsCount}
                                        animationDuration={300}
                                        fontStyle={{ color: isReposted ? "#1DA1F2" : "#536471" }}
                                    />
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.actionItem}
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        handleLike(event);
                                    }}
                                >
                                    <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                        <Ionicons
                                            name={isLiked ? "heart" : "heart-outline"}
                                            size={20}
                                            color={isLiked ? "#F91880" : "#536471"}
                                        />
                                    </Animated.View>
                                    <AnimatedNumbers
                                        includeComma
                                        animateToNumber={likesCount}
                                        animationDuration={300}
                                        fontStyle={{ color: isLiked ? "#F91880" : "#536471" }}
                                    />
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
                                    <AnimatedNumbers
                                        includeComma
                                        animateToNumber={bookmarksCount}
                                        animationDuration={300}
                                        fontStyle={{ color: isBookmarked ? "#1DA1F2" : "#536471" }}
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
