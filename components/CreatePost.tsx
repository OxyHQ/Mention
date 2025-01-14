import React from 'react'
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
import { Ionicons } from "@expo/vector-icons";
import { colors } from '@/styles/colors'
import { useState } from 'react'
import { usePostsStore } from '../store/stores/postStore'
import { v4 as uuidv4 } from 'uuid';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { MediaIcon } from '@/assets/icons/media-icon';

interface Props {
    style?: ViewStyle
}

export const CreatePost: React.FC<Props> = ({ style }) => {
    const [data, setData] = useState('')
    const storePost = usePostsStore((state) => state.addPost)
    const onChange = (text: string) => {
        setData(text)
    }
    const post = () => {
        if (data) {
            storePost({
                id: uuidv4(), // Generate a unique ID for the post
                text: data,
                author_id: '1', // Ensure this is correctly set
                author: {
                    id: '1',
                    name: 'Nate Moore',
                    username: 'TheNateMoore',
                    image: 'https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857',
                    email: '',
                    description: '',
                    color: '#1DA1F2',
                },
                created_at: new Date().toLocaleString(),
                updated_at: new Date().toLocaleString(),
                likes: 0,
                reposts: 0,
                replies: 0,
                bookmarks: 0,
                media: [],
                quoted_post: null,
                quotes: 0,
                comments: 0,
                source: '',
                in_reply_to_user_id: null,
                in_reply_to_username: null,
                is_quote_status: false,
                quoted_status_id: null,
                quote_count: 0,
                reply_count: 0,
                repost_count: 0,
                favorite_count: 0,
                possibly_sensitive: false,
                lang: 'en',
                quoted_post_id: null,
                in_reply_to_status_id: null,
                _count: {
                    comments: 0,
                    likes: 0,
                    quotes: 0,
                    reposts: 0,
                    bookmarks: 0,
                    replies: 0,
                },
            });
            setData(''); // Clear the input field after posting
        }
    }
    return (
        <View style={[styles.container, style]}>
            <View style={styles.topRow}>
                <Pressable
                    onPress={post}
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
                <Image
                    style={styles.profileImage}
                    source={{
                        uri: 'https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857',
                    }}
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
                        style={({ hovered }) => [
                            styles.svgWrapper,
                            hovered
                                ? {
                                    backgroundColor: colors.primaryLight_1,
                                }
                                : {},
                        ]}>
                        <MediaIcon
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
                        <Ionicons
                            name="bar-chart"
                            fill={colors.primaryColor}
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
                        <Ionicons
                            name="add-circle" fill={colors.primaryColor} size={20} />
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
                        <Ionicons
                            name="calendar"
                            fill={colors.primaryColor}
                            size={18}
                        />
                    </Pressable>
                </View>
            </View>
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
        paddingHorizontal: 15,
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
        paddingBottom: 20,
        paddingHorizontal: 15,
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
        // ...Platform.select({
        //   web: {
        //     input: {
        //       outline: 'none',
        //     },
        //   },
        // }),
    },
    // bottomRow: {
    //   flexDirection: 'row',
    //   paddingHorizontal: 15,
    // },
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
        paddingHorizontal: 6,
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
})
