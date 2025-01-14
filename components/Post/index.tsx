import React, { useState, useRef } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity, Animated, Easing, Share, ViewStyle } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from 'expo-sharing';
import { Post as PostType } from "@/interfaces/Post";
import { Image as RNImage } from "react-native";
import { detectHashtags } from "./utils";
import { renderMedia, renderPoll, renderLocation, renderQuotedPost } from "./renderers";
import AnimatedNumbers from 'react-native-animated-numbers';

export default function Post({ postData, style, quotedPost }: { postData: PostType, style?: ViewStyle, quotedPost?: boolean }) {
    const [isLiked, setIsLiked] = useState(false);
    const [likesCount, setLikesCount] = useState(postData._count.likes);
    const [isBookmarked, setIsBookmarked] = useState(false);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isReposted, setIsReposted] = useState(false);
    const [repostsCount, setRepostsCount] = useState(postData._count.reposts);
    const [bookmarksCount, setBookmarksCount] = useState(postData._count.bookmarks);
    const [repliesCount, setRepliesCount] = useState(postData._count.replies);

    const animatedScale = useRef(new Animated.Value(1)).current;
    const animatedOpacity = useRef(new Animated.Value(1)).current;
    const animatedLikesCount = useRef(new Animated.Value(postData._count.likes)).current;
    const animatedRepostsCount = useRef(new Animated.Value(postData._count.reposts)).current;
    const animatedBookmarksCount = useRef(new Animated.Value(postData._count.bookmarks)).current;
    const animatedRepliesCount = useRef(new Animated.Value(postData._count.replies)).current;

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
            <Link href={`/post/${postData.id}`} asChild>
                <TouchableOpacity>
                    <View style={[styles.container, style]}>
                        <Image source={{ uri: postData.author?.image }} style={styles.avatar} />
                        <View style={styles.contentContainer}>
                            <View style={styles.header}>
                                <Text style={styles.name}>{postData.author?.name}</Text>
                                <Text style={styles.username}>{postData.author?.username}</Text>
                                <Text style={styles.time}>· {postData.created_at}</Text>
                            </View>
                            <Text style={styles.content}>{detectHashtags(postData.text)}</Text>
                            {renderMedia(postData.media)}
                            {renderPoll(undefined, selectedOption, handlePollOptionPress)}
                            {renderLocation(undefined)}
                            {!quotedPost && renderQuotedPost(postData.quoted_post_id ?? undefined)}
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
