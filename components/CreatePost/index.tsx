import React, { useState, useEffect, useContext } from 'react'
import {
    StyleSheet,
    Image,
    View,
    Text,
    ViewStyle,
    TextInput,
    Platform,
} from 'react-native'
import { Pressable, PressableStateCallbackType } from 'react-native'
import { colors } from '@/styles/colors'
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { MediaIcon } from '@/assets/icons/media-icon';
import { LocationIcon } from '@/assets/icons/location-icon';
import { HandleIcon } from '@/assets/icons/handle-icon';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import { useSelector, useDispatch } from 'react-redux';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import Avatar from '../Avatar';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { profileService } from '@/modules/oxyhqservices';
import { AppDispatch } from '@/store/store';
import type { Post } from '@/interfaces/Post';
import { OXY_CLOUD_URL } from '@/config';
import { postData } from '@/utils/api';

interface Props {
    style?: ViewStyle
    onClose?: () => void
    onPress?: () => void
    replyToPostId?: string
    repostPostId?: string
    replyToPost?: Post
    repostPost?: Post
    onPostCreated?: () => void
}

export const CreatePost: React.FC<Props> = ({
    style,
    onClose,
    onPress,
    replyToPostId,
    repostPostId,
    replyToPost,
    repostPost,
    onPostCreated
}) => {
    const [text, setText] = useState('')
    const [selectedMedia, setSelectedMedia] = useState<{ uri: string, type: 'image' | 'video', id: string }[]>([]);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isModalVisible, setModalVisible] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [hashtagQuery, setHashtagQuery] = useState('');
    const [mentionResults, setMentionResults] = useState<any[]>([]);
    const [hashtagResults, setHashtagResults] = useState<string[]>([]);
    const [cursorPosition, setCursorPosition] = useState(0);
    const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
    const [showHashtagSuggestions, setShowHashtagSuggestions] = useState(false);
    const dispatch = useDispatch<AppDispatch>();
    const sessionContext = useContext(SessionContext);
    const currentUserId = sessionContext?.getCurrentUserId();
    const [avatarId, setAvatarId] = useState<string | undefined>();

    useEffect(() => {
        if (currentUserId) {
            const fetchProfile = async () => {
                try {
                    const profileData = await profileService.getProfileById(currentUserId);
                    setAvatarId(profileData.avatar);
                } catch (error) {
                    console.error('Error fetching profile:', error);
                }
            };
            fetchProfile();
        }
    }, [currentUserId]);

    const extractMentionsAndHashtags = (text: string) => {
        const mentions = text.match(/@[\w]+/g) || [];
        const hashtags = text.match(/#[\w]+/g) || [];
        return {
            mentions: mentions.map(m => m.slice(1)), // Remove @ symbol
            hashtags: hashtags.map(h => h.slice(1)) // Remove # symbol
        };
    };

    const handleTextChange = async (newText: string) => {
        setText(newText);
        const lastWord = newText.slice(0, cursorPosition).split(/\s/).pop() || '';

        if (lastWord.startsWith('@')) {
            setMentionQuery(lastWord.slice(1));
            setShowMentionSuggestions(true);
            setShowHashtagSuggestions(false);
            // Fetch mention suggestions
            try {
                const response = await postData('users/search', { query: lastWord.slice(1) });
                setMentionResults(response.data);
            } catch (error) {
                console.error('Error fetching mentions:', error);
            }
        } else if (lastWord.startsWith('#')) {
            setHashtagQuery(lastWord.slice(1));
            setShowHashtagSuggestions(true);
            setShowMentionSuggestions(false);
            // Fetch hashtag suggestions
            try {
                const response = await postData('hashtags/search', { query: lastWord.slice(1) });
                setHashtagResults(response.data);
            } catch (error) {
                console.error('Error fetching hashtags:', error);
            }
        } else {
            setShowMentionSuggestions(false);
            setShowHashtagSuggestions(false);
        }
    };

    const handleSelectionChange = (event: any) => {
        setCursorPosition(event.nativeEvent.selection.start);
    };

    const insertMention = (username: string) => {
        const textBeforeCursor = text.slice(0, cursorPosition);
        const textAfterCursor = text.slice(cursorPosition);
        const lastWordStart = textBeforeCursor.lastIndexOf('@');
        const newText = textBeforeCursor.slice(0, lastWordStart) + `@${username} ` + textAfterCursor;
        setText(newText);
        setShowMentionSuggestions(false);
    };

    const insertHashtag = (hashtag: string) => {
        const textBeforeCursor = text.slice(0, cursorPosition);
        const textAfterCursor = text.slice(cursorPosition);
        const lastWordStart = textBeforeCursor.lastIndexOf('#');
        const newText = textBeforeCursor.slice(0, lastWordStart) + `#${hashtag} ` + textAfterCursor;
        setText(newText);
        setShowHashtagSuggestions(false);
    };

    const post = async () => {
        if (text && currentUserId) {
            try {
                const { mentions, hashtags } = extractMentionsAndHashtags(text);

                const newPost: Partial<Post> = {
                    userID: currentUserId,
                    text: text,
                    media: selectedMedia.map(media => media.id),
                    created_at: new Date().toISOString(),
                    source: 'web',
                    in_reply_to_status_id: replyToPostId || null,
                    quoted_post_id: repostPostId || null,
                    lang: 'en',
                    mentions: mentions,
                    hashtags: hashtags,
                    _count: {
                        comments: 0,
                        likes: 0,
                        quotes: 0,
                        reposts: 0,
                        bookmarks: 0,
                        replies: 0
                    }
                };

                const response = await postData('posts', newPost);
                setText('');
                setSelectedMedia([]);
                if (onPostCreated) onPostCreated();
                if (onClose) onClose();
            } catch (error) {
                console.error('Error creating post:', error);
            }
        }
    };

    const onEmojiClick = (emojiData: EmojiClickData) => {
        setText(text + emojiData.emoji);
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
            uri: `${OXY_CLOUD_URL}${file._id}`,
            type: file.contentType.startsWith('image/') ? 'image' : 'video' as 'image' | 'video',
            id: file._id
        }));
        setSelectedMedia([...selectedMedia, ...media]);
    };

    return (
        <View style={[styles.container, style]}>
            <View style={styles.topRow}>
                {onClose && (
                    <Pressable
                        onPress={onClose}
                        style={text ? styles.button : styles.buttonDisabled}>
                        <Text style={styles.buttonText}>Cancel</Text>
                    </Pressable>
                )}
                <Pressable
                    onPress={post}
                    style={text ? styles.button : styles.buttonDisabled}>
                    <Text style={styles.buttonText}>{replyToPostId ? 'Reply' : repostPostId ? 'Quote' : 'Post'}</Text>
                </Pressable>
            </View>
            {replyToPost && (
                <View style={styles.replyingContainer}>
                    <Text style={styles.replyingText}>
                        Replying to <Text style={styles.replyingUsername}>@{replyToPost.author?.username}</Text>
                    </Text>
                </View>
            )}
            {repostPost && (
                <View style={styles.repostingContainer}>
                    <Text style={styles.repostingText}>
                        Quoting post from <Text style={styles.repostingUsername}>@{repostPost.author?.username}</Text>
                    </Text>
                    <View style={styles.quotedPostPreview}>
                        <Text numberOfLines={2} style={styles.quotedPostText}>{repostPost.text}</Text>
                    </View>
                </View>
            )}
            {replyToPostId && (
                <Text style={styles.replyingText}>
                    Replying to post
                </Text>
            )}
            <View style={styles.middleRow}>
                <Avatar
                    style={styles.profileImage}
                    id={avatarId}
                />
                <TextInput
                    style={styles.middleRowText}
                    placeholder={replyToPostId ? "Post your reply" : repostPostId ? "Add a quote" : "What's happening?"}
                    value={text}
                    multiline={true}
                    onChangeText={handleTextChange}
                    onSelectionChange={handleSelectionChange}
                />
            </View>
            {showMentionSuggestions && mentionResults.length > 0 && (
                <View style={styles.suggestionsContainer}>
                    {mentionResults.map((user) => (
                        <Pressable
                            key={user.id}
                            style={styles.suggestionItem}
                            onPress={() => insertMention(user.username)}>
                            <Avatar id={user.avatar} style={styles.suggestionAvatar} />
                            <View>
                                <Text style={styles.suggestionName}>{user.name.first} {user.name.last}</Text>
                                <Text style={styles.suggestionUsername}>@{user.username}</Text>
                            </View>
                        </Pressable>
                    ))}
                </View>
            )}
            {showHashtagSuggestions && hashtagResults.length > 0 && (
                <View style={styles.suggestionsContainer}>
                    {hashtagResults.map((hashtag) => (
                        <Pressable
                            key={hashtag}
                            style={styles.suggestionItem}
                            onPress={() => insertHashtag(hashtag)}>
                            <Text style={styles.suggestionHashtag}>#{hashtag}</Text>
                        </Pressable>
                    ))}
                </View>
            )}
            <View style={styles.bottomRow}>
                <View style={styles.iconsContainer}>
                    <Pressable
                        onPress={openModal}
                        style={({ pressed }) => [
                            styles.svgWrapper,
                            pressed && { backgroundColor: colors.primaryLight_1 }
                        ]}>
                        <MediaIcon size={20} />
                    </Pressable>
                    <Pressable
                        onPress={() => setShowEmojiPicker(!showEmojiPicker)}
                        style={({ pressed }) => [
                            styles.svgWrapper,
                            pressed && { backgroundColor: colors.primaryLight_1 }
                        ]}>
                        <EmojiIcon size={20} />
                    </Pressable>
                    <Pressable
                        style={({ pressed }) => [
                            styles.svgWrapper,
                            pressed && { backgroundColor: colors.primaryLight_1 }
                        ]}>
                        <LocationIcon size={20} />
                    </Pressable>
                    <Pressable
                        style={({ pressed }) => [
                            styles.svgWrapper,
                            pressed && { backgroundColor: colors.primaryLight_1 }
                        ]}>
                        <HandleIcon size={18} />
                    </Pressable>
                </View>
            </View>
            {showEmojiPicker && (
                <EmojiPicker
                    style={{ width: '100%', border: 'none' }}
                    onEmojiClick={onEmojiClick}
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
                    options={{
                        fileTypeFilter: ["image/", "video/"],
                        maxFiles: 5,
                    }}
                />
            )}
        </View>
    );
};

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
    replyingText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginBottom: 8,
        paddingHorizontal: 12,
    },
    replyingContainer: {
        padding: 10,
        backgroundColor: '#fff',
        borderRadius: 10,
        marginBottom: 10,
    },
    replyingUsername: {
        fontWeight: 'bold',
        color: colors.primaryColor,
    },
    repostingContainer: {
        padding: 10,
        backgroundColor: '#fff',
        borderRadius: 10,
        marginBottom: 10,
    },
    repostingText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginBottom: 8,
        paddingHorizontal: 12,
    },
    repostingUsername: {
        fontWeight: 'bold',
        color: colors.primaryColor,
    },
    quotedPostPreview: {
        marginTop: 10,
        padding: 10,
        backgroundColor: '#fff',
        borderRadius: 10,
    },
    quotedPostText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    suggestionsContainer: {
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        backgroundColor: '#fff',
        borderRadius: 8,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        zIndex: 1000,
        maxHeight: 200,
        overflow: 'scroll',
    },
    suggestionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    suggestionAvatar: {
        width: 30,
        height: 30,
        borderRadius: 15,
        marginRight: 10,
    },
    suggestionName: {
        fontWeight: 'bold',
        fontSize: 14,
    },
    suggestionUsername: {
        color: colors.COLOR_BLACK_LIGHT_3,
        fontSize: 12,
    },
    suggestionHashtag: {
        fontSize: 14,
        color: colors.primaryColor,
    },
});
