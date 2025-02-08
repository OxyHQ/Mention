import React, { useState, useEffect, useRef, useContext } from "react";
import {
    Text,
    View,
    StyleSheet,
    TouchableOpacity,
    SafeAreaView,
    Image,
    Dimensions,
    Platform,
    Animated,
    TouchableWithoutFeedback,
    ActivityIndicator
} from "react-native";
import axios from "axios";
import Post from "@/components/Post";
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import TextTicker from "react-native-text-ticker";
import { ScrollView } from "react-native-gesture-handler";
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { colors } from "@/styles/colors";
import { router } from 'expo-router';
import { useMediaQuery } from "react-responsive";
import { Ionicons } from "@expo/vector-icons";
import { Post as IPost } from "@/interfaces/Post";
import { RootState, AppDispatch } from '@/store/store';
import { Video, ResizeMode } from 'expo-av';

const { width, height } = Dimensions.get("window");

const VideoFeed: React.FC = () => {
    const posts = useSelector((state: RootState) => state.posts.posts);
    const error = useSelector((state: RootState) => state.posts.error);
    const dispatch = useDispatch<AppDispatch>();
    const [loading, setLoading] = useState(true);
    const [liked, setLiked] = useState(false);
    const [lastTap, setLastTap] = useState<number | null>(null);
    const scaleValue = useRef(new Animated.Value(0)).current;
    const scrollViewRef = useRef<ScrollView>(null);
    const isScreenNotMobileResult = useMediaQuery({ minWidth: 500 });
    const session = useContext(SessionContext);

    const styles = StyleSheet.create({
        container: {
            width: "100%",
            zIndex: 1,
            alignSelf: "stretch",
            backgroundColor: "black",
            borderBottomLeftRadius: 35,
            borderBottomRightRadius: 35,
            ...(isScreenNotMobileResult && {
                borderRadius: 35,
            }),
            overflow: "hidden",
            ...(!isScreenNotMobileResult && {
                height: height - 90,
            }),
            ...(isScreenNotMobileResult && {
                height: height - 40,
            }),
        },
        centered: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
        },
        errorText: {
            color: 'red',
            fontSize: 18,
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
            ...(!isScreenNotMobileResult && {
                height: height - 90,
            }),
            ...(isScreenNotMobileResult && {
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
            position: "absolute",
            top: 40,
            left: 0,
            flexDirection: "row",
            alignItems: "center",
            width: "100%",
            zIndex: 7,
            justifyContent: 'center'
        },
        spanCenterHeader: {
            color: "white",
            fontSize: 20
        },
        textLeftHeader: {
            color: "grey",
            paddingHorizontal: 10,
            fontSize: 20
        },
        textRightHeader: {
            color: "white",
            paddingHorizontal: 10,
            fontSize: 20,
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
        description: { 
            color: "white", 
            marginTop: 2, 
            fontSize: 15 
        },
        likeIcon: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            marginLeft: -50,
            marginTop: -50,
            zIndex: 3,
        },
    });

    useEffect(() => {
        if (!session?.getCurrentUser()) {
            router.push('/login');
            return;
        }
        dispatch(fetchPosts());
    }, [dispatch, session]);

    useEffect(() => {
        if (Array.isArray(posts) && posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    if (loading) {
        return (
            <View style={[styles.container, styles.centered]}>
                <ActivityIndicator size="large" color={colors.primaryColor} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.container, styles.centered]}>
                <Text style={styles.errorText}>{error}</Text>
            </View>
        );
    }

    function handleLike() {
        setLiked(!liked);
    }

    const handleDoubleTap = () => {
        const now = Date.now();
        if (lastTap && (now - lastTap) < 300) {
            // Double tap detected
            Animated.sequence([
                Animated.spring(scaleValue, {
                    toValue: 1,
                    useNativeDriver: true,
                }),
                Animated.spring(scaleValue, {
                    toValue: 0,
                    useNativeDriver: true,
                }),
            ]).start();
            setLiked(true);
        } else {
            setLastTap(now);
        }
    };

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

    return (
        <>
            <View style={styles.header}>
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
                    {posts.map((post: IPost) => (
                        <TouchableWithoutFeedback key={post.id} onPress={handleDoubleTap}>
                            <View style={[styles.page_container, styles.post]}>
                                <Video
                                    source={{
                                        uri: post?.media ? post.media[0] : "https://videos.pexels.com/video-files/26867688/12024499_1080_1920_30fps.mp4",
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
                                <Animated.View style={[styles.likeIcon, { transform: [{ scale: scaleValue }] }]}>
                                    <Ionicons name="heart" size={100} color="red" />
                                </Animated.View>
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
                        </TouchableWithoutFeedback>
                    ))}
                </ScrollView>
            </View>
        </>
    );
}

export default VideoFeed;