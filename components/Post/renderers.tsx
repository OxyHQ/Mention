import React, { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, Image as RNImage, StyleSheet, Modal, ScrollView, PanResponder, Platform, ImageStyle } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import { fetchPosts } from "@/store/reducers/postsReducer";
import { Ionicons } from "@expo/vector-icons";
import Post from ".";
import { colors } from "@/styles/colors";
import { fetchData } from "@/utils/api";
import AutoWidthImage from "./components/AutoWidthImage ";
import { Video, ResizeMode } from 'expo-av'; // Using expo-av for video playback
import { OXY_CLOUD_URL } from "@/config";

export const renderMedia = (mediaIds: string[]) => {
    const [mediaData, setMediaData] = useState<any[]>([]);
    const [images, setImages] = useState<{ id: string, uri: string }[]>([]);
    const [videos, setVideos] = useState<{ id: string, uri: string }[]>([]);
    const [documents, setDocuments] = useState<{ id: string, uri: string }[]>([]);
    const [selectedImage, setSelectedImage] = useState<{ id: string; uri: string } | null>(null);
    const [selectedVideo, setSelectedVideo] = useState<{ id: string; uri: string } | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchMediaData = async () => {
            if (!mediaIds || mediaIds.length === 0) return;

            try {
                setError(null);
                const response = await fetchData("files/data/" + mediaIds.filter(Boolean).join(","));

                if (!Array.isArray(response)) {
                    throw new Error("Invalid response format");
                }

                setMediaData(response);

                const fetchedImages = response
                    .filter((item: { contentType: string; }) => item?.contentType?.startsWith("image/"))
                    .map((item: { id: any; }) => ({ id: item.id, uri: `${OXY_CLOUD_URL}${item.id}` }));

                const fetchedVideos = response
                    .filter((item: { contentType: string; }) => item?.contentType?.startsWith("video/"))
                    .map((item: { id: any; }) => ({ id: item.id, uri: `${OXY_CLOUD_URL}${item.id}` }));

                const fetchedDocuments = response
                    .filter((item: { contentType: string; }) =>
                        item?.contentType &&
                        !item.contentType.startsWith("image/") &&
                        !item.contentType.startsWith("video/")
                    )
                    .map((item: { id: any; }) => ({ id: item.id, uri: `${OXY_CLOUD_URL}${item.id}` }));

                setImages(fetchedImages);
                setVideos(fetchedVideos);
                setDocuments(fetchedDocuments);
            } catch (error: any) {
                console.error("Error fetching media data:", error);
                setError(error?.response?.data?.message || "Error loading media");
                setImages([]);
                setVideos([]);
                setDocuments([]);
            }
        };

        fetchMediaData();
    }, [mediaIds]);

    const handleImagePress = (event: any, image: { id: string, uri: string }) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedImage(image);
    };

    const handleVideoPress = (event: any, video: { id: string, uri: string }) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedVideo(video);
    };

    const handleModalClose = () => {
        setSelectedImage(null);
        setSelectedVideo(null);
    };

    const scrollViewRef = useRef<ScrollView>(null);
    const scrollX = useRef(0);
    const startX = useRef(0);
    const isDragging = useRef(false);

    const panResponder = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
            isDragging.current = true;
            startX.current = evt.nativeEvent.pageX;
            if (scrollViewRef.current) {
                scrollX.current = scrollViewRef.current?.getScrollableNode()?.scrollLeft || 0;
            }
        },
        onPanResponderMove: (evt) => {
            if (!isDragging.current || !scrollViewRef.current) return;

            const currentX = evt.nativeEvent.pageX;
            const diff = startX.current - currentX;
            scrollViewRef.current.scrollTo({ x: scrollX.current + diff, animated: false });
        },
        onPanResponderRelease: () => {
            isDragging.current = false;
        },
    });

    return (
        <>
            <View {...panResponder.panHandlers}>
                <ScrollView
                    ref={scrollViewRef}
                    horizontal
                    style={styles.scrollView}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.contentContainer}
                >
                    {images.map((image, index) => (
                        <AutoWidthImage key={image.id} uri={image.uri} style={styles.mediaItem} />
                    ))}
                </ScrollView>
            </View>
            <View style={styles.videoGrid}>
                {videos.map((video, index) => (
                    <TouchableOpacity
                        key={index}
                        onPress={(event) => handleVideoPress(event, video)}
                        accessibilityLabel={`Video ${index + 1}`}
                    >
                        <Video
                            source={{ uri: video.uri }}
                            style={[styles.video]}
                            onError={(err: any) => {
                                const errorMessage = typeof err === 'string' ? err : err?.message || 'Unknown error';
                                console.error("Error loading video:", errorMessage);
                            }}
                        />
                    </TouchableOpacity>
                ))}
            </View>
            <View style={styles.documentGrid}>
                {documents.map((document, index) => (
                    <TouchableOpacity
                        key={index}
                        onPress={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            window.open(document.uri, "_blank");
                        }}
                        accessibilityLabel={`Document ${index + 1}`}
                    >
                        <Text style={styles.documentText}>Document {index + 1}</Text>
                    </TouchableOpacity>
                ))}
            </View>
            {selectedImage && (
                <Modal
                    visible={true}
                    transparent={true}
                    onRequestClose={handleModalClose}
                >
                    <View style={styles.imageModalContainer}>
                        <TouchableOpacity
                            style={styles.imageModalCloseButton}
                            onPress={handleModalClose}
                            accessibilityLabel="Close image modal"
                        >
                            <Ionicons name="close" size={30} color="#FFFFFF" />
                        </TouchableOpacity>
                        <RNImage source={{ uri: selectedImage.uri }} style={styles.imageModalImage} />
                    </View>
                </Modal>
            )}
            {selectedVideo && (
                <Modal
                    visible={true}
                    transparent={true}
                    onRequestClose={handleModalClose}
                >
                    <View style={styles.videoModalContainer}>
                        <TouchableOpacity
                            style={styles.videoModalCloseButton}
                            onPress={handleModalClose}
                            accessibilityLabel="Close video modal"
                        >
                            <Ionicons name="close" size={30} color="#FFFFFF" />
                        </TouchableOpacity>
                        <Video source={{ uri: selectedVideo.uri }} style={styles.videoModalImage} useNativeControls resizeMode={ResizeMode.CONTAIN} />
                    </View>
                </Modal>
            )}
        </>
    );
};

export const renderPoll = (poll: any, selectedOption: number | null, handlePollOptionPress: (index: number) => void) => {
    if (!poll) return null;
    const totalVotes = poll.options.reduce((sum: number, option: any) => sum + option.votes, 0);
    return (
        <View style={styles.pollContainer}>
            <Text style={styles.pollQuestion}>{poll.question}</Text>
            {poll.options.map((option: any, index: number) => {
                const percentage = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
                return (
                    <TouchableOpacity
                        key={index}
                        style={[
                            styles.pollOption,
                            selectedOption === index && styles.selectedPollOption,
                        ]}
                        onPress={(event) => { event.preventDefault(); event.stopPropagation(); handlePollOptionPress(index); }}
                    >
                        <Text style={styles.pollOptionText}>{option.text}</Text>
                        <Text style={styles.pollOptionStats}>{`${option.votes} votes (${percentage.toFixed(1)}%)`}</Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );
};

export const renderLocation = (location: string | undefined) => {
    if (!location) return null;
    return (
        <View style={styles.locationContainer}>
            <Ionicons name="location-outline" size={16} color="#1DA1F2" />
            <Text style={styles.locationText}>{location}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    scrollView: {
        flexGrow: 0,
        paddingLeft: 62,
    },
    contentContainer: {
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 0,
        paddingRight: 10,
        gap: 10,
    },
    mediaItem: {
        borderRadius: 35,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        ...((Platform.select({
            web: {
                cursor: 'grab',
            },
        }) as unknown) as ImageStyle),

    },
    videoGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "space-between",
    },
    video: {
        flex: 1,
        width: 250,
        height: 250,
        margin: 5,
        borderRadius: 35,
    },
    documentGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "space-between",
    },
    documentText: {
        flex: 1,
        margin: 5,
        padding: 10,
        borderWidth: 1,
        borderColor: "#e1e8ed",
        borderRadius: 8,
        backgroundColor: "#fff",
        textAlign: "center",
    },
    imageModalContainer: {
        flex: 1,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        justifyContent: "center",
        alignItems: "center",
    },
    videoModalContainer: {
        flex: 1,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        justifyContent: "center",
        alignItems: "center",
    },
    imageModalImage: {
        width: "90%",
        height: "70%",
        borderRadius: 10,
    },
    videoModalImage: {
        width: "90%",
        height: "70%",
    },
    imageModalCloseButton: {
        position: "absolute",
        top: 40,
        right: 20,
    },
    videoModalCloseButton: {
        position: "absolute",
        top: 40,
        right: 20,
    },
    pollContainer: {
        marginTop: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: "#e1e8ed",
        borderRadius: 8,
        backgroundColor: "#f5f8fa",
    },
    pollQuestion: {
        fontWeight: "bold",
        marginBottom: 12,
        fontSize: 16,
    },
    pollOption: {
        padding: 10,
        borderWidth: 1,
        borderColor: "#e1e8ed",
        borderRadius: 8,
        marginTop: 8,
        backgroundColor: "#fff",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },
    pollOptionText: {
        flex: 1,
        fontSize: 14,
    },
    pollOptionStats: {
        fontSize: 12,
        color: "#657786",
    },
    selectedPollOption: {
        backgroundColor: "#e1f5fe",
        borderColor: "#1DA1F2",
    },
    locationContainer: {
        flexDirection: "row",
        alignItems: "center",
        marginTop: 8,
    },
    locationText: {
        marginLeft: 4,
        color: "#1DA1F2",
    },
});
