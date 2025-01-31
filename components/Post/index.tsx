import React, { useRef, useState, useEffect } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity, Animated, Easing, Share, ViewStyle } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from 'expo-sharing';
import { Post as PostType } from "@/interfaces/Post";
import Avatar from "@/components/Avatar";
import { detectHashtags } from "./utils";
import { renderMedia, renderPoll, renderLocation, renderQuotedPost } from "./renderers";
import AnimatedNumbers from 'react-native-animated-numbers';
import { useDispatch, useSelector } from 'react-redux';
import { updateLikes, bookmarkPost, fetchBookmarkedPosts } from '@/store/reducers/postsReducer';
import { Chat } from "@/assets/icons/chat-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { RepostIcon } from "@/assets/icons/repost-icon";
import { HeartIcon, HeartIconActive } from "@/assets/icons/heart-icon";
import { CommentIcon, CommentIconActive } from "@/assets/icons/comment-icon";
import { colors } from "@/styles/colors";

export default function Post({ postData, style, quotedPost, showActions }: { postData: PostType, style?: ViewStyle, quotedPost?: boolean, showActions?: boolean }) {
    const dispatch = useDispatch();
    const likesCount = useSelector((state) => state.posts.posts.find(post => post.id === postData.id)?._count?.likes || 0);
    const isLiked = useSelector((state) => state.posts.posts.find(post => post.id === postData.id)?.isLiked || false);
    const [isBookmarked, setIsBookmarked] = useState(false);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isReposted, setIsReposted] = useState(false);
    const [repostsCount, setRepostsCount] = useState(postData?._count?.reposts);
    const [bookmarksCount, setBookmarksCount] = useState(postData?._count?.bookmarks);
    const [repliesCount, setRepliesCount] = useState(postData?._count?.replies);

    const animatedScale = useRef(new Animated.Value(1)).current;
    const animatedOpacity = useRef(new Animated.Value(1)).current;
    const animatedRepostsCount = useRef(new Animated.Value(postData?._count?.reposts)).current;
    const animatedBookmarksCount = useRef(new Animated.Value(postData?._count?.bookmarks)).current;
    const animatedRepliesCount = useRef(new Animated.Value(postData?._count?.replies)).current;

    useEffect(() => {
        dispatch(fetchBookmarkedPosts());
    }, [dispatch]);

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
        dispatch(updateLikes(postData.id));
        scaleAnimation();
        fadeAnimation();
    };

    const handleShare = async (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            await Share.share({
                message: `Check out this post: https://mention.earth/post/${postData.id}`,
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
        dispatch(bookmarkPost(postData.id));
        Animated.timing(animatedBookmarksCount, {
            toValue: newBookmarksCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: true,
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
            useNativeDriver: true,
        }).start();
    };

    const handleReply = (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        const newRepliesCount = repliesCount + 1;
        setRepliesCount(newRepliesCount);
        Animated.timing(animatedRepliesCount, {
            toValue: newRepliesCount,
            duration: 300,
            easing: Easing.linear,
            useNativeDriver: true,
        }).start();
    };

    const handlePollOptionPress = (index: number) => {
        setSelectedOption(index);
    };

    return (
        <>
            <TouchableOpacity>
                <View style={[styles.container, style]}>
                    <View style={styles.topContainer}>
                        <Link href={`/@${postData.author?.username}`} asChild>
                            <TouchableOpacity>
                                <Avatar id={postData?.author?.avatar} size={40} />
                            </TouchableOpacity>
                        </Link>
                        <View style={{ flex: 1, }}>
                            <View style={styles.headerContainer}>
                                <View style={styles.headerData}>
                                    <Link href={`/@${postData.author?.username}`} asChild>
                                        <TouchableOpacity>
                                            <Text style={styles.authorName}>{postData.author?.name?.first} {postData.author?.name?.last}</Text>
                                        </TouchableOpacity>
                                    </Link>
                                    <Link href={`/@${postData.author?.username}`} asChild>
                                        <TouchableOpacity>
                                            <Text style={styles.authorUsername}>@{postData.author?.username}</Text>
                                        </TouchableOpacity>
                                    </Link>
                                    <Text style={styles.postTime}>· {new Date(postData.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                                </View>
                                <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
                            </View>
                            {postData?.text && <Text style={styles.postContent}>{detectHashtags(postData.text)}</Text>}
                        </View>
                    </View>
                    <View style={styles.contentContainer}>
                        {postData?.media && renderMedia(postData.media)}
                        {renderPoll(undefined, selectedOption, handlePollOptionPress)}
                        {renderLocation(undefined)}
                        {!quotedPost && renderQuotedPost(postData.quoted_post_id ?? undefined)}
                        <View style={styles.actionsContainer}>
                            <TouchableOpacity
                                style={styles.actionButton}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    handleLike(event);
                                }}
                            >
                                <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isLiked ? <HeartIconActive size={20} color="#F91880" /> : <HeartIcon size={20} color="#536471" />}
                                </Animated.View>
                                <AnimatedNumbers
                                    includeComma
                                    animateToNumber={likesCount}
                                    animationDuration={300}
                                    fontStyle={{ color: isLiked ? "#F91880" : "#536471" }}
                                />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.actionButton}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    handleReply(event);
                                }}
                            >
                                {false ? <CommentIconActive size={20} color="#F91880" /> : <CommentIcon size={20} color="#536471" />}
                                <AnimatedNumbers
                                    includeComma
                                    animateToNumber={repliesCount}
                                    animationDuration={300}
                                    fontStyle={{ color: "#536471" }}
                                />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.actionButton}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    handleRepost(event);
                                }}
                            >
                                {isReposted ? <RepostIcon size={20} color="#1DA1F2" /> : <RepostIcon size={20} color="#536471" />}
                                <AnimatedNumbers
                                    includeComma
                                    animateToNumber={repostsCount}
                                    animationDuration={300}
                                    fontStyle={{ color: isReposted ? "#1DA1F2" : "#536471" }}
                                />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.actionButton}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    handleShare(event);
                                }}
                            >
                                <Ionicons name="share-outline" size={20} color="#536471" />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.actionButton}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    handleBookmark(event);
                                }}
                            >
                                {isBookmarked ? <BookmarkActive size={20} strokeWidth={2} color="#1DA1F2" /> : <Bookmark size={20} strokeWidth={1} color="#536471" />}
                                <AnimatedNumbers
                                    includeComma
                                    animateToNumber={bookmarksCount}
                                    animationDuration={300}
                                    fontStyle={{ color: isBookmarked ? "#1DA1F2" : "#536471" }}
                                />
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.actionButton}
                            >
                                <Chat
                                    size={20}
                                    color="#536471"
                                />
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </TouchableOpacity>
        </>
    );
}

const postPaddingLeft = 62;

const styles = StyleSheet.create({
    container: {
        flexDirection: "column",
        borderBottomColor: "#e1e8ed",
        borderBottomWidth: 1,
        paddingVertical: 12,
    },
    topContainer: {
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: 12,
        alignItems: "flex-start",
    },
    contentContainer: {
        flex: 1,
    },
    headerContainer: {
        flexDirection: "row",
        alignItems: "center",
    },
    headerData: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        gap: 4,
    },
    authorName: {
        fontWeight: "bold",
    },
    authorUsername: {
        color: "#536471",
    },
    postTime: {
        color: "#536471",
    },
    postContent: {
        marginTop: 4,
        lineHeight: 20,
    },
    actionsContainer: {
        flexDirection: "row",
        marginTop: 12,
        justifyContent: "space-between",
        maxWidth: 300,
        paddingLeft: postPaddingLeft,
    },
    actionButton: {
        flexDirection: "row",
        alignItems: "center",
        marginRight: 16,
        gap: 4,
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
