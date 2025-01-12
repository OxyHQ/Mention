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
import { Pressable } from 'react-native-web-hover'
import { Ionicons } from "@expo/vector-icons";
import { colors } from '@/styles/colors'
import { useState } from 'react'
import { useStore } from '../store/store'

interface Props {
    style?: ViewStyle
}

export const CreatePostTopRow: React.FC<Props> = ({ }) => {
    return (
        <View style={styles.topRow}>
            <Text style={styles.topRowText}>Home</Text>

            <Pressable
                style={({ hovered }) => [
                    styles.startContainer,
                    hovered
                        ? {
                            backgroundColor: colors.COLOR_BLACK_LIGHT_6,
                        }
                        : {},
                ]}>
                <Ionicons name="star" size={18} />
            </Pressable>
        </View>
    )
}
export const CreatePost: React.FC<Props> = ({ style }) => {
    const [data, setData] = useState('')
    const storePost = useStore((state) => state.addPost)
    const onChange = (text: string) => {
        setData(text)
    }
    const post = () => {
        if (data) {
            storePost({
                fullName: 'Ehsan Sarshar',
                userNameAndDate: '@TheEhsanSarshar . 10m',
                profileUrl:
                    'https://pbs.twimg.com/profile_images/1389235685345959942/B1yoUQGj_400x400.jpg',
                content: data,
            })
        }
    }
    return (
        <View style={[styles.container, style]}>
            <View style={styles.middleRow}>
                <Image
                    style={styles.profileImage}
                    source={{
                        uri: 'https://pbs.twimg.com/profile_images/1389235685345959942/B1yoUQGj_400x400.jpg',
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
                        <Ionicons
                            name="image-outline"
                            fill={colors.primaryColor}
                            size={18}
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
                            name="gift"
                            fill={colors.primaryColor} size={18} />
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
                            size={18}
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
                            name="add-circle" fill={colors.primaryColor} size={18} />
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
                <Pressable
                    onPress={post}
                    style={data ? styles.button : styles.buttonDisabled}>
                    <Text style={styles.buttonText}>Post</Text>
                </Pressable>
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
        borderBottomWidth: 0.01,
        paddingHorizontal: 15,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        paddingVertical: 5,
        ...Platform.select({
            web: {
                position: 'sticky',
            },
        }),
        top: 0,
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
        paddingVertical: 12,
        paddingHorizontal: 15,
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
        paddingVertical: 12,
        paddingHorizontal: 15,
        marginEnd: 15,
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
        width: 40,
        height: 40,
    },
    startContainer: {
        borderRadius: 100,
        padding: 10,
    },
})
