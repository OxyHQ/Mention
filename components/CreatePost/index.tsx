import React, { useState, useEffect } from 'react'
import {
    StyleSheet,
    Image,
    View,
    Text,
    ViewStyle,
    TextInput,
    Platform,
} from 'react-native'
import { Pressable } from 'react-native'
import { colors } from '@/styles/colors'
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { MediaIcon } from '@/assets/icons/media-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { HandleIcon } from '@/assets/icons/handle-icon';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import EmojiPicker from 'emoji-picker-react';
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts, createPost } from '@/store/reducers/postsReducer';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import Avatar from '../Avatar';

interface Props {
    style?: ViewStyle
    onClose?: () => void
}

export const CreatePost: React.FC<Props> = ({ style, onClose }) => {
    const [data, setData] = useState('')
    const [selectedMedia, setSelectedMedia] = useState<{ uri: string, type: 'image' | 'video', id: string }[]>([]);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isModalVisible, setModalVisible] = useState(false);
    const dispatch = useDispatch();

    useEffect(() => {
        dispatch(fetchPosts());
    }, [dispatch]);

    const onChange = (text: string) => {
        setData(text)
    }
    const post = () => {
        if (data) {
            const newPost = {
                userID: '678b29d19085a13337ca9fd4',
                text: data,
                media: selectedMedia.map(media => media.id),
            };
            dispatch(createPost(newPost));
            setData('');
            setSelectedMedia([]);
            if (onClose) onClose();
        }
    }

    const onEmojiClick = (event, emojiObject) => {
        setData(data + emojiObject.emoji);
        setShowEmojiPicker(false);
    };

    const openModal = () => {
        setModalVisible(true);
    };

    const closeModal = () => {
        setModalVisible(false);
    };

    const onSelect = (selectedFiles: any[]) => {
        const media = selectedFiles.map(file => ({
            uri: `${process.env.OXY_CLOUD_URL}/files/${file._id}`,
            type: file.contentType.startsWith('image/') ? 'image' : 'video',
            id: file._id
        }));
        setSelectedMedia([...selectedMedia, ...media]);
    };

    return (
        <View style={[styles.container, style]}>
            <View style={styles.topRow}>
                <Pressable
                    onPress={onClose}
                    style={data ? styles.button : styles.buttonDisabled}>
                    <Text style={styles.buttonText}>Cancel</Text>
                </Pressable>
                <Pressable
                    onPress={post}
                    style={data ? styles.button : styles.buttonDisabled}>
                    <Text style={styles.buttonText}>Post</Text>
                </Pressable>
            </View>
            <View style={styles.middleRow}>
                <Avatar
                    style={styles.profileImage}
                    id=""
                />
                <TextInput
                    style={styles.middleRowText}
                    placeholder="What's happening?"
                    value={data}
                    multiline={true}
                    onChangeText={onChange}
                />
            </View>
            <View style={styles.bottomRow}>
                <View style={styles.iconsContainer}>
                    <Pressable
                        onPress={openModal}
                        style={({ hovered }) => [
                            styles.svgWrapper,
                            hovered
                                ? {
                                    backgroundColor: colors.primaryLight_1,
                                }
                                : {},
                        ]}>
                        <MediaIcon size={20} />
                    </Pressable>
                    <Pressable
                        onPress={() => setShowEmojiPicker(!showEmojiPicker)}
                        style={({ hovered }) => [
                            styles.svgWrapper,
                            hovered
                                ? {
                                    backgroundColor: colors.primaryLight_1,
                                }
                                : {},
                        ]}>
                        <EmojiIcon size={20} />
                    </Pressable>
                    <Pressable
                        style={({ hovered }) => [
                            styles.svgWrapper,
                            hovered
                                ? {
                                    backgroundColor: colors.primaryLight_1,
                                }
                                : {},
                        ]}>
                        <LocationIcon
                            size={20}
                        />
                    </Pressable>
                    <Pressable
                        style={({ hovered }) => [
                            styles.svgWrapper,
                            hovered
                                ? {
                                    backgroundColor: colors.primaryLight_1,
                                }
                                : {},
                        ]}>
                        <HandleIcon size={18} />
                    </Pressable>
                </View>
            </View>
            {showEmojiPicker && (
                <EmojiPicker
                    style={{ width: '100%', border: 'none' }}
                    onEmojiClick={(event, emojiObject) => onEmojiClick(event, emojiObject)}
                />
            )}
            <View style={styles.mediaPreviewContainer}>
                {selectedMedia.map((asset, index) => (
                    asset.type === "image" ? (
                        <Image key={index} source={{ uri: asset.uri }} style={styles.mediaPreview} />
                    ) : (
                        <Video
                            key={index}
                            source={{ uri: asset.uri }}
                            style={styles.mediaPreview}
                            useNativeControls
                            resizeMode={ResizeMode.CONTAIN}
                            shouldPlay
                            isLooping
                            isMuted
                        />
                    )
                ))}
            </View>
            {isModalVisible && (
                <FileSelectorModal
                    visible={isModalVisible}
                    onClose={closeModal}
                    onSelect={onSelect}
                    userId="user123"
                    options={{
                        fileTypeFilter: ["image/", "video/"],
                        maxFiles: 5,
                    }}
                />
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        paddingBottom: 10,
    },
    topRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingTop: 10,
        backgroundColor: '#fff',
        zIndex: 100,
        borderRadius: 35,
    } as ViewStyle,
    topRowText: {
        fontSize: 20,
        color: colors.COLOR_BLACK_LIGHT_4,
        fontWeight: '800',
        paddingStart: 1,
    },
    middleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 10,
        paddingBottom: 15,
        paddingHorizontal: 10,
    },
    middleRowText: {
        fontSize: 20,
        color: colors.COLOR_BLACK_LIGHT_4,
        fontWeight: '500',
        paddingTop: 5,
        ...Platform.select({
            web: {
                outlineStyle: 'none',
            },
        }),
        width: '100%',
        height: '100%',
        flexWrap: 'wrap',
    },
    profileImage: {
        width: 50,
        height: 50,
        borderRadius: 100,
        marginEnd: 15,
    },
    iconsContainer: {
        flexDirection: 'row',
        paddingStart: 65,
        justifyContent: 'space-around',
        gap: 5,
    },
    bottomRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: '100%',
        paddingHorizontal: 5,
    },
    button: {
        borderRadius: 100,
        backgroundColor: colors.primaryColor,
        paddingVertical: 9,
        paddingHorizontal: 12,
        marginEnd: 15,
        ...Platform.select({
            web: {
                cursor: 'pointer',
            },
        }),
    },
    buttonDisabled: {
        borderRadius: 100,
        backgroundColor: colors.primaryColor,
        opacity: 0.5,
        paddingVertical: 9,
        paddingHorizontal: 12,
    },
    buttonText: {
        fontSize: 15,
        color: '#fff',
        fontWeight: 'bold',
    },
    svgWrapper: {
        borderRadius: 100,
        justifyContent: 'center',
        alignItems: 'center',
        width: 30,
        height: 30,
    },
    startContainer: {
        borderRadius: 100,
        padding: 10,
    },
    mediaPreviewContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginVertical: 10,
        paddingHorizontal: 10,
        gap: 5,
    },
    mediaPreview: {
        width: 100,
        height: 100,
        borderRadius: 35,
    },
})
