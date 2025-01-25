import React, { useState, useEffect, useRef } from "react";
import {
    Text,
    View,
    StyleSheet,
    TouchableOpacity,
    SafeAreaView,
    Image,
    Dimensions
} from "react-native";
import axios from "axios";

import TextTicker from "react-native-text-ticker";
import { ScrollView } from "react-native-gesture-handler";

const { width, height } = Dimensions.get("window");

import { Video, ResizeMode } from "expo-av";

function Feed() {
    const [feedd, setfeed] = useState([]);
    const [liked, setLiked] = useState(false);
    const scrollViewRef = useRef<ScrollView>(null);

    function handleLike() {
        setLiked(!liked);
    }

    interface FeedItem {
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
        const index = Math.round(y / height);
        if (scrollViewRef.current) {
            scrollViewRef.current.scrollTo({ y: index * height, animated: true });
        }
    };

    const feed = [
        {
            id: 1,
            video_url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4",
            description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam nec nunc nec nisi ultricies lacinia. Nullam nec nunc nec nisi ultricies lacinia.",
            author: {
                name: "John Doe",
                avatar: "https://avatars.githubusercontent.com/u/1?v=4"
            },
            hashtags: "#hashtag1 #hashtag2 #hashtag3"
        },
        {
            id: 2,
            video_url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4",
            description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam nec nunc nec nisi ultricies lacinia. Nullam nec nunc nec nisi ultricies lacinia.",
            author: {
                name: "John Doe",
                avatar: "https://avatars.githubusercontent.com/u/1?v=4"
            },
            hashtags: "#hashtag1 #hashtag2 #hashtag3"
        },
    ];

    return (
        <SafeAreaView>
            <View style={[{ zIndex: 7 }, styles.header]}>
                <View>
                    <TouchableOpacity>
                        <Text style={styles.textLeftHeader}>Seguindo</Text>
                    </TouchableOpacity>
                </View>
                <Text style={styles.spanCenterHeader}>|</Text>
                <View>
                    <TouchableOpacity>
                        <Text style={styles.textRightHeader}>Para você</Text>
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
                    {feed.map(item => (
                        <View key={item.id} style={[styles.page_container, styles.post]}>
                            <View style={styles.video}>
                                <Video
                                    source={{
                                        uri: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4"
                                        //uri: item.video_url
                                    }}
                                    rate={1.0}
                                    volume={1.0}
                                    isMuted={true}
                                    resizeMode={ResizeMode.COVER}
                                    shouldPlay
                                    isLooping
                                    style={styles.videoPlayer}
                                    useNativeControls={false}
                                />
                            </View>
                            <View style={styles.content}>
                                <View style={styles.InnerContent}>
                                    <TouchableOpacity>
                                        <Text style={styles.name}>{item.author.name}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity>
                                        <Text style={styles.description} numberOfLines={5}>
                                            {item.description}
                                        </Text>
                                    </TouchableOpacity>
                                    <Text style={styles.hashtags}>{item.hashtags}</Text>
                                    <TouchableOpacity>
                                        <Text style={styles.translate}>VER TRADUÇÂO</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.componentMusic}>
                                        <View style={styles.imageIconMusic}>
                                            <Image style={styles.iMusic} />
                                        </View>
                                        <TextTicker
                                            style={styles.nameMusic}
                                            duration={4000}
                                            loop
                                            bounce={false}
                                            repeatSpacer={70}
                                            marqueeDelay={1000}
                                            shouldAnimateTreshold={40}
                                        >
                                            I Don’t Care - Ed Sheeran Part Justin Bieber
                                        </TextTicker>
                                    </TouchableOpacity>
                                </View>
                            </View>
                            <View style={styles.contentIcon}>
                                <View style={styles.contentIconProfile}>
                                    <TouchableOpacity>
                                        <Image

                                            style={styles.iconProfile}
                                        />
                                    </TouchableOpacity>
                                    <TouchableOpacity>
                                        <Image style={styles.iconPlusProfile} />
                                    </TouchableOpacity>
                                </View>
                                <View style={styles.iconsAction}>
                                    <View style={styles.contentIconAction}>
                                        <TouchableOpacity onPress={handleLike}>
                                            <Image
                                                style={styles.iconAction}
                                            />
                                        </TouchableOpacity>
                                        <Text style={styles.textActions}>153.1K</Text>
                                    </View>
                                    <TouchableOpacity style={styles.contentIconAction}>
                                        <Image style={styles.iconAction} />
                                        <Text style={styles.textActions}>208</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.contentIconAction}>
                                        <Image style={styles.iconWhatsapp} />
                                        <Text style={styles.textActions}>Compar-tilhar</Text>
                                    </TouchableOpacity>
                                </View>
                                <View>
                                    <TouchableOpacity>
                                        <Image

                                            style={styles.iconMusic}
                                        />
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>
                    ))}
                </ScrollView>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        width: "100%",
        height: height,
        backgroundColor: "black",
        zIndex: 1,
        alignSelf: "stretch"
    },
    post: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        zIndex: 2,
        alignSelf: "stretch",
        position: "relative",
        bottom: 30
    },
    page_container: {
        width: width,
        height: height,
    },
    video: {
        width: "100%",
        flex: 1,
        zIndex: 2
    },
    videoPlayer: {
        width: "100%",
        zIndex: 2,
        flex: 1
    },
    header: {
        flexDirection: "row",
        position: "absolute",
        top: 40,
        left: 75,
        alignItems: "center"
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
        width: "75%",
        position: "absolute",
        left: 0,
        bottom: 0,
        zIndex: 3
    },
    InnerContent: {
        width: "100%",
        position: "relative",
        bottom: 0,
        justifyContent: "flex-end",
        paddingHorizontal: 10,
        flexDirection: "column"
    },

    name: { color: "white", marginVertical: 3, fontSize: 15, fontWeight: "bold" },
    description: { color: "white", marginTop: 2, fontSize: 15 },
    hashtags: { color: "white", fontWeight: "bold" },
    componentMusic: {
        flexDirection: "row",
        alignItems: "center",
        marginVertical: 10,
        width: 190
    },
    imageIconMusic: {
        marginRight: 15
    },
    iMusic: {
        width: 20,
        height: 20,
        resizeMode: "contain"
    },
    nameMusic: {
        color: "white",
        fontSize: 15
    },
    translate: {
        fontWeight: "bold",
        color: "white",
        marginVertical: 5
    },
    contentIcon: {
        width: "20%",
        position: "absolute",
        bottom: 11,
        right: 0,
        alignItems: "center",
        zIndex: 3
    },
    contentIconProfile: {
        alignItems: "center",
        marginBottom: 2
    },

    iconProfile: {
        width: 50,
        height: 50,
        resizeMode: "cover",
        borderRadius: 25,
        borderColor: "white",
        borderWidth: 1
    },
    iconPlusProfile: {
        height: 35,
        width: 25,
        position: "relative",
        bottom: 20,
        zIndex: 5,
        resizeMode: "contain"
    },
    iconsAction: {
        alignItems: "center",
        marginBottom: 20
    },
    contentIconAction: {
        alignItems: "center",
        marginBottom: 13
    },
    iconAction: {
        height: 40,
        width: 40
    },
    iconWhatsapp: {
        height: 40,
        width: 40,
        resizeMode: "cover",
        borderRadius: 20
    },
    textActions: { color: "white", textAlign: "center", width: 54 },
    iconMusic: {
        width: 50,
        height: 50,
        resizeMode: "cover",
        borderRadius: 30
    }
});

export default Feed;