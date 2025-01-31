import React, { useState, useEffect, useRef } from "react";
import {
    Text,
    View,
    StyleSheet,
    TouchableOpacity,
    SafeAreaView,
    Image,
    Dimensions,
    Platform
} from "react-native";
import axios from "axios";
import Post from "@/components/Post";
import TextTicker from "react-native-text-ticker";
import { ScrollView } from "react-native-gesture-handler";

const { width, height } = Dimensions.get("window");

import { Video, ResizeMode } from 'expo-av';
import Avatar from "@/components/Avatar";
import { Chat } from "@/assets/icons/chat-icon";
import { HeartIcon, HeartIconActive } from "@/assets/icons/heart-icon";
import { CommentIcon } from "@/assets/icons/comment-icon";
import { useMediaQuery } from "react-responsive";


export default Feed = () => {
    const [liked, setLiked] = useState(false);
    const scrollViewRef = useRef<ScrollView>(null);
    const isScreenNotMobile = useMediaQuery({ minWidth: 500 });

    function handleLike() {
        setLiked(!liked);
    }

    interface FeedPost {
        id: number;
        video_url: string;
        description: string;
        author: {
            name: string;
            avatar: string;
        };
        hashtags: string;
    }

    interface ScrollEvent {
        nativeEvent: {
            contentOffset: {
                y: number;
            };
        };
    }

    const handleScroll = (event: ScrollEvent): void => {
        const { y } = event.nativeEvent.contentOffset;
        const index = Math.round(height);
        if (scrollViewRef.current) {
            scrollViewRef.current.scrollTo({ y: index * height, animated: false });
        }
    };

    const feedData = [
        {
            id: "1",
            text: "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
            source: "web",
            in_reply_to_user_id: null,
            in_reply_to_username: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author: {
                id: "1",
                username: "mention",
                name: {
                    first: "Mention",
                },
                email: "hello@mention.earth",
                description: "A new social network for a new world.",
                color: "#000000",
            },
            media: [
                "https://videos.pexels.com/video-files/26867688/12024499_1080_1920_30fps.mp4"
            ],
            quoted_post: null,
            is_quote_status: false,
            quoted_status_id: null,
            possibly_sensitive: false,
            lang: "en",
            _count: {
                likes: 0,
                reposts: 0,
                bookmarks: 0,
                replies: 0,
                quotes: 0,
            },
        },
        {
            id: "1",
            text: "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
            source: "web",
            in_reply_to_user_id: null,
            in_reply_to_username: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author: {
                id: "1",
                username: "mention",
                name: {
                    first: "Mention",
                },
                email: "hello@mention.earth",
                description: "A new social network for a new world.",
                color: "#000000",
            },
            media: [
                "https://videos.pexels.com/video-files/30441554/13045108_1440_2560_30fps.mp4"
            ],
            quoted_post: null,
            is_quote_status: false,
            quoted_status_id: null,
            possibly_sensitive: false,
            lang: "en",
            _count: {
                likes: 0,
                reposts: 0,
                bookmarks: 0,
                replies: 0,
                quotes: 0,
            },
        },
        {
            id: "1",
            text: "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
            source: "web",
            in_reply_to_user_id: null,
            in_reply_to_username: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            author: {
                id: "1",
                username: "mention",
                name: {
                    first: "Mention",
                },
                email: "hello@mention.earth",
                description: "A new social network for a new world.",
                color: "#000000",
            },
            media: [
                "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4"
            ],
            quoted_post: null,
            is_quote_status: false,
            quoted_status_id: null,
            possibly_sensitive: false,
            lang: "en",
            _count: {
                likes: 0,
                reposts: 0,
                bookmarks: 0,
                replies: 0,
                quotes: 0,
            },
        },
    ];

    const styles = StyleSheet.create({
        container: {
            width: "100%",
            zIndex: 1,
            alignSelf: "stretch",
            backgroundColor: "black",
            borderBottomLeftRadius: 35,
            borderBottomRightRadius: 35,
            ...(isScreenNotMobile && {
                borderRadius: 35,
            }),
            overflow: "hidden",
            ...(!isScreenNotMobile && {
                height: height - 90,
            }),
            ...(isScreenNotMobile && {
                height: height - 40,
            }),
        },
        post: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            zIndex: 2,
            alignSelf: "stretch",
        },
        page_container: {
            width: width,
            ...(!isScreenNotMobile && {
                height: height - 90,
            }),
            ...(isScreenNotMobile && {
                height: height - 40,
            }),
        },
        videoPlayer: {
            width: "100%",
            height: "100%",
            position: "absolute",
            zIndex: 2,
            flex: 1,
        },
        header: {
            flexDirection: "row",
            position: "absolute",
            top: 40,
            left: 0,
            alignItems: "center",
            width: "100%",
        },
        spanCenterHeader: { color: "white", fontSize: 10 },
        textLeftHeader: {
            color: "grey",
            paddingHorizontal: 10,
            fontSize: 20
        },

        textRightHeader: {
            color: "white",
            paddingHorizontal: 10,
            fontSize: 23,
            fontWeight: "bold"
        },
        content: {
            width: "100%",
            position: "absolute",
            left: 0,
            bottom: 0,
            zIndex: 3,
            paddingBottom: 10,

        },
        InnerContent: {
            width: "100%",
            position: "relative",
            bottom: 0,
            justifyContent: "flex-end",
            paddingHorizontal: 10,
            flexDirection: "column"
        },
        description: { color: "white", marginTop: 2, fontSize: 15 },
    });

    return (
        <>
            <View style={[{ zIndex: 7 }, styles.header]}>
                <View>
                    <TouchableOpacity>
                        <Text style={styles.textLeftHeader}>Following</Text>
                    </TouchableOpacity>
                </View>
                <Text style={styles.spanCenterHeader}>|</Text>
                <View>
                    <TouchableOpacity>
                        <Text style={styles.textRightHeader}>For you</Text>
                    </TouchableOpacity>
                </View>
            </View>
            <View style={styles.container}>
                <ScrollView
                    ref={scrollViewRef}
                    onScrollEndDrag={handleScroll}
                    showsVerticalScrollIndicator={false}
                    pagingEnabled
                >
                    {feedData.map(post => (
                        <View key={post.id} style={[styles.page_container, styles.post]}>
                            <Video
                                source={{
                                    uri: post?.media[0],
                                }}
                                rate={1.0}
                                volume={1.0}
                                isMuted={Platform.OS === 'web' ? true : false}
                                shouldPlay
                                isLooping={true}
                                style={styles.videoPlayer}
                                useNativeControls={false}
                                resizeMode={ResizeMode.CONTAIN}
                                videoStyle={{ width: "100%", height: "100%" }}
                            />
                            <View style={styles.content}>
                                <View style={styles.InnerContent}>
                                    <Post postData={post} style={{
                                        width: "100%",
                                        borderRadius: 15,
                                        borderBottomLeftRadius: 30,
                                        borderBottomRightRadius: 30,
                                    }} />
                                </View>
                            </View>
                        </View>
                    ))}
                </ScrollView>
            </View>
        </>
    );


}