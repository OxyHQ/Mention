import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import React, { useRef, useState, useEffect } from 'react';
import {
    Animated,
    Image,
    ImageBackground,
    StatusBar,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy, FollowButton } from '@oxyhq/services';
import { useLocalSearchParams } from 'expo-router';

const HEADER_HEIGHT_EXPANDED = 80;
const HEADER_HEIGHT_NARROWED = 110;

const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView as any);

interface Post {
    id: string;
    user: {
        name: string;
        handle: string;
        avatar: string;
        verified: boolean;
    };
    content: string;
    date: string;
    engagement: {
        replies: number;
        reposts: number;
        likes: number;
    };
}

const TwitterProfile: React.FC = () => {
    const { user: currentUser, logout, oxyServices, showBottomSheet } = useOxy();
    let { username } = useLocalSearchParams<{ username: string }>();
    if (username && username.startsWith('@')) {
        username = username.slice(1);
    }

    const [activeTab, setActiveTab] = useState(0);
    const [profileData, setProfileData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const scrollY = useRef(new Animated.Value(0)).current;
    const insets = useSafeAreaInsets();

    // Fetch profile data
    useEffect(() => {
        const fetchProfileData = async () => {
            if (!username) {
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                const data = await oxyServices.users.getProfileByUsername(username);
                console.log('Fetched profile data:', data);
                setProfileData(data);
            } catch (error) {
                console.error('Error fetching profile data:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchProfileData();
    }, [username, oxyServices]);

    const mockPosts: Post[] = [
        {
            id: '1',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: "Text slide animation in @reactnative @expo😷\n\nw/@swmansion's reanimated + expo-blur 🔥\nproduct/ ordio.com 💙",
            date: '29.04.25',
            engagement: { replies: 30, reposts: 82, likes: 1300 },
        },
        {
            id: '2',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Building landing components just got easier! 🚀\n\n@landingcomps is the fastest way to ship beautiful landing pages. Pre-built, customizable, and React-ready.',
            date: '28.04.25',
            engagement: { replies: 45, reposts: 112, likes: 890 },
        },
        {
            id: '3',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'AI prompt engineering made simple ✨\n\n@niceprompt helps you craft better prompts and get better results from AI. Game changer for productivity!',
            date: '27.04.25',
            engagement: { replies: 67, reposts: 201, likes: 1450 },
        },
        {
            id: '4',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Ship faster, design better 🎯\n\nCombining @landingcomps + @niceprompt workflow has 10x my productivity. From idea to shipped product in hours, not days.',
            date: '26.04.25',
            engagement: { replies: 89, reposts: 324, likes: 2100 },
        },
        {
            id: '5',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Just dropped a new React Native animation tutorial on YouTube! 📹\n\nCovers advanced Reanimated 3 techniques and performance optimization tips. Link in bio 👆',
            date: '25.04.25',
            engagement: { replies: 156, reposts: 445, likes: 2890 },
        },
        {
            id: '6',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Hot take: Design systems are only as good as their adoption rate.\n\nDocumentation, developer experience, and team buy-in matter more than perfect components.',
            date: '24.04.25',
            engagement: { replies: 78, reposts: 267, likes: 1567 },
        },
        {
            id: '7',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Working on something big with the @landingcomps team 👀\n\nHint: It involves AI-powered component generation. Can\'t wait to share more soon! 🤖✨',
            date: '23.04.25',
            engagement: { replies: 234, reposts: 567, likes: 3456 },
        },
        {
            id: '8',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'TypeScript tip: Use const assertions for better type inference 💡\n\nconst colors = ["red", "blue"] as const;\n// Now colors is readonly ["red", "blue"] instead of string[]',
            date: '22.04.25',
            engagement: { replies: 45, reposts: 178, likes: 923 },
        },
        {
            id: '9',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Berlin tech scene is absolutely thriving! 🇩🇪\n\nAmazing to see so many innovative startups and passionate developers here. The future is bright! ⚡',
            date: '21.04.25',
            engagement: { replies: 67, reposts: 234, likes: 1234 },
        },
        {
            id: '10',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Remember: Code is written once, but read many times.\n\nWrite for your future self and your teammates. Clear, readable code > clever code. 📚💭',
            date: '20.04.25',
            engagement: { replies: 123, reposts: 456, likes: 2345 },
        },
    ];

    const replyPosts: Post[] = [
        {
            id: 'r1',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Exactly! The key is finding the right balance between innovation and maintainability. Thanks for sharing your thoughts! 💯',
            date: '2h',
            engagement: { replies: 12, reposts: 34, likes: 156 },
        },
        {
            id: 'r2',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Have you tried using Zustand for state management? It\'s been a game changer for our React Native projects at @ordio 🚀',
            date: '4h',
            engagement: { replies: 23, reposts: 67, likes: 289 },
        },
        {
            id: 'r3',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Great question! We use a combination of Figma tokens and Style Dictionary to maintain design consistency across platforms 🎨',
            date: '6h',
            engagement: { replies: 45, reposts: 123, likes: 567 },
        },
        {
            id: 'r4',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Absolutely agree! Performance should be a first-class citizen in any React Native app. Have you profiled with Flipper yet? 📊',
            date: '8h',
            engagement: { replies: 18, reposts: 56, likes: 234 },
        },
        {
            id: 'r5',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Thanks for the kind words! Always happy to help the community grow. DM me if you need any specific guidance 📩',
            date: '12h',
            engagement: { replies: 34, reposts: 89, likes: 445 },
        },
        {
            id: 'r6',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'This is such an important point! Accessibility should never be an afterthought. WCAG guidelines are a great starting point 🌐',
            date: '1d',
            engagement: { replies: 67, reposts: 178, likes: 723 },
        },
        {
            id: 'r7',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Love seeing the React Native community grow! Your animation work is inspiring. Keep pushing the boundaries! 🌟',
            date: '1d',
            engagement: { replies: 29, reposts: 78, likes: 356 },
        },
        {
            id: 'r8',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Expo has come such a long way! The developer experience improvements in SDK 50 are incredible. What\'s your favorite new feature? 🤔',
            date: '2d',
            engagement: { replies: 56, reposts: 145, likes: 689 },
        },
        {
            id: 'r9',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'Couldn\'t agree more! User research is the foundation of great UX. Data-driven design decisions always win in the long run 📈',
            date: '3d',
            engagement: { replies: 41, reposts: 112, likes: 478 },
        },
        {
            id: 'r10',
            user: {
                name: 'Eren Arica',
                handle: 'imeronn',
                avatar: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg',
                verified: true,
            },
            content: 'This thread is gold! 🏆 Saving for future reference. The component composition patterns you shared are brilliant 🧠',
            date: '4d',
            engagement: { replies: 38, reposts: 167, likes: 834 },
        },
    ];

    const likedPosts: Post[] = [
        {
            id: 'l1',
            user: {
                name: 'Sarah Chen',
                handle: 'sarahdesigns',
                avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=100&h=100&fit=crop&crop=face',
                verified: false,
            },
            content: 'Just shipped a new design system! 🎨 The component library approach is game-changing for design consistency.',
            date: '1h',
            engagement: { replies: 12, reposts: 45, likes: 230 },
        },
        {
            id: 'l2',
            user: {
                name: 'Alex Turner',
                handle: 'alexcodes',
                avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face',
                verified: true,
            },
            content: 'React Native performance tip: Use FlatList for large datasets instead of ScrollView with map() 🚀',
            date: '3h',
            engagement: { replies: 28, reposts: 156, likes: 892 },
        },
        {
            id: 'l3',
            user: {
                name: 'Maya Patel',
                handle: 'mayauxui',
                avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop&crop=face',
                verified: false,
            },
            content: 'UX research insight: Users scan in F-patterns on web, but Z-patterns on mobile. Design accordingly! 📱💻',
            date: '5h',
            engagement: { replies: 67, reposts: 203, likes: 1205 },
        },
        {
            id: 'l4',
            user: {
                name: 'Tom Wilson',
                handle: 'tomdevs',
                avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=face',
                verified: true,
            },
            content: 'TypeScript + React Native = ❤️\n\nCatch bugs at compile time, better IntelliSense, and more maintainable code.',
            date: '8h',
            engagement: { replies: 34, reposts: 89, likes: 567 },
        },
        {
            id: 'l5',
            user: {
                name: 'Lisa Rodriguez',
                handle: 'lisabrands',
                avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100&h=100&fit=crop&crop=face',
                verified: false,
            },
            content: 'Brand colors psychology:\n🔴 Red: Energy, urgency\n🔵 Blue: Trust, stability\n🟢 Green: Growth, nature\n🟡 Yellow: Optimism, creativity',
            date: '12h',
            engagement: { replies: 45, reposts: 178, likes: 923 },
        },
        {
            id: 'l6',
            user: {
                name: 'David Kim',
                handle: 'davidtech',
                avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=face',
                verified: true,
            },
            content: 'AI is not replacing designers. Designers who use AI are replacing designers who don\'t. 🤖✨',
            date: '1d',
            engagement: { replies: 123, reposts: 456, likes: 2341 },
        },
        {
            id: 'l7',
            user: {
                name: 'Emma Johnson',
                handle: 'emmawrites',
                avatar: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=100&h=100&fit=crop&crop=face',
                verified: false,
            },
            content: 'Content strategy tip: Write for humans first, SEO second. Authentic voice always wins over keyword stuffing. 📝',
            date: '1d',
            engagement: { replies: 67, reposts: 234, likes: 1456 },
        },
        {
            id: 'l8',
            user: {
                name: 'Mike Chen',
                handle: 'mikebuilds',
                avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=100&h=100&fit=crop&crop=face',
                verified: true,
            },
            content: 'Frontend performance checklist:\n✅ Image optimization\n✅ Code splitting\n✅ Lazy loading\n✅ CDN usage\n✅ Bundle analysis',
            date: '2d',
            engagement: { replies: 89, reposts: 367, likes: 1789 },
        },
        {
            id: 'l9',
            user: {
                name: 'Sofia Martinez',
                handle: 'sofiadata',
                avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=100&h=100&fit=crop&crop=face',
                verified: false,
            },
            content: 'Data visualization principle: If your chart needs a legend, your design needs work. Make it self-explanatory! 📊',
            date: '3d',
            engagement: { replies: 45, reposts: 156, likes: 892 },
        },
        {
            id: 'l10',
            user: {
                name: 'James Park',
                handle: 'jamesux',
                avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=100&h=100&fit=crop&crop=face',
                verified: true,
            },
            content: 'Design systems aren\'t just component libraries. They\'re the DNA of your product\'s user experience. 🧬',
            date: '4d',
            engagement: { replies: 78, reposts: 289, likes: 1567 },
        },
    ];

    const mediaImages = [
        'https://images.unsplash.com/photo-1551650975-87deedd944c3?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1517077304055-6e89abbf09b0?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1581291518857-4e27b48ff24e?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1487014679447-9f8336841d58?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1605379399642-870262d3d051?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1573164713714-d95e436ab8d6?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1576091160399-112ba8d25d1f?w=400&h=400&fit=crop',
        'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400&h=400&fit=crop',
    ];

    const tabs = ['Posts', 'Replies', 'Media', 'Likes'];
    const tabData = [mockPosts, replyPosts, mediaImages, likedPosts];

    const onTabPress = (index: number) => {
        setActiveTab(index);
    };

    const renderPost = ({ item }: { item: Post }) => (
        <View style={styles.postContainer}>
            <Image source={{ uri: item.user.avatar }} style={styles.postAvatar} />
            <View style={styles.postContent}>
                <View style={styles.postHeader}>
                    <Text style={styles.postUserName}>
                        {item.user.name}
                        {item.user.verified && (
                            <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" style={styles.verifiedIcon} />
                        )}
                    </Text>
                    <Text style={styles.postHandle}>@{item.user.handle}</Text>
                    <Text style={styles.postDate}>· {item.date}</Text>
                </View>
                <Text style={styles.postText}>{item.content}</Text>
                <View style={styles.postEngagement}>
                    <TouchableOpacity style={styles.engagementButton}>
                        <Ionicons name="chatbubble-outline" size={18} color="#71767B" />
                        <Text style={styles.engagementText}>{item.engagement.replies}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.engagementButton}>
                        <Ionicons name="repeat-outline" size={18} color="#71767B" />
                        <Text style={styles.engagementText}>{item.engagement.reposts}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.engagementButton}>
                        <Ionicons name="heart-outline" size={18} color="#71767B" />
                        <Text style={styles.engagementText}>{item.engagement.likes.toLocaleString()}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.engagementButton}>
                        <Ionicons name="share-outline" size={18} color="#71767B" />
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    );

    const renderMediaGrid = (images: string[]) => {
        const rows = [];
        for (let i = 0; i < images.length; i += 3) {
            const rowImages = images.slice(i, i + 3);
            rows.push(
                <View key={i} style={styles.mediaRow}>
                    {rowImages.map((imageUrl, index) => (
                        <TouchableOpacity key={i + index} style={styles.mediaImageContainer}>
                            <Image source={{ uri: imageUrl }} style={styles.mediaImage} />
                        </TouchableOpacity>
                    ))}
                </View>
            );
        }
        return <View style={styles.mediaGrid}>{rows}</View>;
    };

    const renderTabContent = () => {
        const data = tabData[activeTab];

        if (activeTab === 2) { // Media tab
            return renderMediaGrid(data as string[]);
        }

        if (!data || data.length === 0) {
            return <View style={styles.emptyTabView} />;
        }

        return (
            <View>
                {(data as Post[]).map(item => (
                    <View key={item.id}>{renderPost({ item })}</View>
                ))}
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {loading ? (
                <View style={styles.loadingContainer}>
                    <Text style={styles.loadingText}>Loading profile...</Text>
                </View>
            ) : (
                <>
                    {/* Back button */}
                    <View style={[styles.backButton, { top: insets.top + 5 }]}>
                        <TouchableOpacity onPress={() => router.back()}>
                            <Ionicons name="arrow-back" size={20} color="white" />
                        </TouchableOpacity>
                    </View>

                    {/* Header actions */}
                    <View style={[styles.headerActions, { top: insets.top + 5 }]}>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="notifications-outline" size={20} color="white" />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="search-outline" size={20} color="white" />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.headerIconButton}>
                            <Ionicons name="share-outline" size={20} color="white" />
                        </TouchableOpacity>
                    </View>

                    {/* Name + posts count */}
                    <Animated.View
                        style={[
                            styles.headerNameOverlay,
                            {
                                top: insets.top + 6,
                                opacity: scrollY.interpolate({
                                    inputRange: [-50, 80, 120],
                                    outputRange: [0, 0, 1],
                                    extrapolate: 'clamp',
                                }),
                                transform: [
                                    {
                                        translateY: scrollY.interpolate({
                                            inputRange: [-50, 100, 180],
                                            outputRange: [0, 200, 0],
                                            extrapolate: 'clamp',
                                        }),
                                    },
                                ],
                            },
                        ]}
                    >
                        <Text style={styles.headerTitle}>
                            {profileData?.name?.full || profileData?.username}
                        </Text>
                        <Text style={styles.headerSubtitle}>
                            {profileData?.postCount || 0} posts
                        </Text>
                    </Animated.View>

                    {/* Banner */}
                    <AnimatedImageBackground
                        source={{ uri: 'https://pbs.twimg.com/profile_banners/1113181835314507777/1746124248/1500x500' }}
                        style={[
                            styles.banner,
                            {
                                height: HEADER_HEIGHT_EXPANDED + HEADER_HEIGHT_NARROWED,
                                transform: [
                                    {
                                        scale: scrollY.interpolate({
                                            inputRange: [-150, 0],
                                            outputRange: [1.5, 1],
                                            extrapolateLeft: 'extend',
                                            extrapolateRight: 'clamp',
                                        }),
                                    },
                                ],
                            },
                        ]}
                    >
                        <AnimatedBlurView
                            tint="dark"
                            intensity={50}
                            style={[
                                StyleSheet.absoluteFillObject,
                                {
                                    zIndex: 2,
                                    opacity: scrollY.interpolate({
                                        inputRange: [-50, 0, 30, 100],
                                        outputRange: [1, 0, 0, 0.7],
                                    }),
                                },
                            ]}
                        />
                    </AnimatedImageBackground>

                    {/* Profile content + posts */}
                    {/* ScrollView with stickyHeaderIndices */}
                    <Animated.ScrollView
                        showsVerticalScrollIndicator={false}
                        onScroll={Animated.event(
                            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                            { useNativeDriver: true }
                        )}
                        scrollEventThrottle={16}
                        style={[styles.scrollView, { marginTop: HEADER_HEIGHT_NARROWED }]}
                        contentContainerStyle={{ paddingTop: HEADER_HEIGHT_EXPANDED }}
                        stickyHeaderIndices={[1]}
                    >
                        {/* Profile info */}
                        <View style={styles.profileContent}>
                            <View style={styles.avatarRow}>
                                <Animated.Image
                                    source={{ uri: 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg' }}
                                    style={[
                                        styles.avatar,
                                        {
                                            transform: [
                                                {
                                                    scale: scrollY.interpolate({
                                                        inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                                        outputRange: [1, 0.7],
                                                        extrapolate: 'clamp',
                                                    }),
                                                },
                                                {
                                                    translateY: scrollY.interpolate({
                                                        inputRange: [0, HEADER_HEIGHT_EXPANDED],
                                                        outputRange: [0, 16],
                                                        extrapolate: 'clamp',
                                                    }),
                                                },
                                            ],
                                        },
                                    ]}
                                />

                                <View style={styles.profileActions}>
                                    <TouchableOpacity style={styles.followButton}>
                                        <Text style={styles.followButtonText}>Edit Profile</Text>
                                    </TouchableOpacity>
                                    <FollowButton userId={profileData?.id} />
                                </View>
                            </View>

                            <View>
                                <Text style={styles.profileName}>
                                    {profileData?.name?.full || profileData?.username}
                                </Text>
                                <Text style={styles.profileHandle}>
                                    @{profileData?.username || 'username'}
                                </Text>
                            </View>
                            <Text style={styles.profileBio}>
                                {profileData?.bio || 'Good people at '}
                                {profileData?.bio ? '' : <Text style={styles.linkText}>oxy.so</Text>}
                                {profileData?.bio || ' Making a better world with\n'}
                                {profileData?.bio ? '' : <Text style={styles.linkText}>@oxy</Text>}
                                {profileData?.bio || ' I love '}
                                {profileData?.bio ? '' : <Text style={styles.linkText}>@mention</Text>}
                            </Text>

                            <View style={styles.profileMeta}>
                                <View style={styles.metaItem}>
                                    <Ionicons name="location-outline" size={16} color="#666" />
                                    <Text style={styles.metaText}>Berlin</Text>
                                </View>
                                <View style={styles.metaItem}>
                                    <View
                                        style={{
                                            transform: [{ rotate: '-45deg' }],
                                        }}
                                    >
                                        <Ionicons name="link-outline" size={16} color="#666" />
                                    </View>
                                    <Text style={[styles.metaText, styles.linkText]}>erencanarica.com</Text>
                                </View>
                                <View style={styles.metaItem}>
                                    <Ionicons name="calendar-outline" size={16} color="#666" />
                                    <Text style={styles.metaText}>Joined April 2019</Text>
                                </View>
                            </View>

                            <View style={styles.followStats}>
                                <TouchableOpacity style={styles.statItem}>
                                    <Text style={styles.statNumber}>
                                        {profileData?.followingCount || 234}
                                    </Text>
                                    <Text style={styles.statLabel}>Following</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={styles.statItem}>
                                    <Text style={styles.statNumber}>
                                        {profileData?.followersCount || '1.3K'}
                                    </Text>
                                    <Text style={styles.statLabel}>Followers</Text>
                                </TouchableOpacity>
                            </View>

                            {/* Communities section */}
                            <View style={styles.communitiesSection}>
                                <Text style={styles.communitiesTitle}>Communities</Text>
                                <View style={styles.communityCard}>
                                    <View style={styles.communityHeader}>
                                        <View style={styles.communityIcon}>
                                            <Image source={{ uri: 'https://pbs.twimg.com/media/FECS7TfVcAcCrj2?format=jpg&name=medium' }} style={styles.communityIconImage} />
                                        </View>
                                        <View style={styles.communityInfo}>
                                            <Text style={styles.communityName}>Design Engineers</Text>
                                            <Text style={styles.communityDescription}>A space where design and code converge ✨ Share, seek feedback,...</Text>
                                            <View style={styles.communityMembers}>
                                                <View style={styles.memberAvatars}>
                                                    <View style={[styles.memberAvatar, { zIndex: 4 }]}>
                                                        <View style={styles.avatarCircle} />
                                                    </View>
                                                    <View style={[styles.memberAvatar, { zIndex: 3, marginLeft: -8 }]}>
                                                        <View style={styles.avatarCircle} />
                                                    </View>
                                                    <View style={[styles.memberAvatar, { zIndex: 2, marginLeft: -8 }]}>
                                                        <View style={styles.avatarCircle} />
                                                    </View>
                                                    <View style={[styles.memberAvatar, { zIndex: 1, marginLeft: -8 }]}>
                                                        <View style={styles.avatarCircle} />
                                                    </View>
                                                </View>
                                                <Text style={styles.memberCount}>24 Members</Text>
                                            </View>
                                        </View>
                                    </View>
                                    <TouchableOpacity style={styles.viewButtonInCard}>
                                        <Text style={styles.viewButtonText}>View</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>

                        {/* Tabs */}
                        <View style={styles.tabBarContainer}>
                            <View style={styles.tabBar}>
                                {tabs.map((tab, i) => (
                                    <TouchableOpacity
                                        key={tab}
                                        style={styles.tab}
                                        onPress={() => onTabPress(i)}
                                    >
                                        <Text
                                            style={[
                                                styles.tabText,
                                                activeTab === i && styles.activeTabText,
                                            ]}
                                        >
                                            {tab}
                                        </Text>
                                        {activeTab === i && <View style={styles.tabIndicator} />}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>

                        {/* Tab Content */}
                        {renderTabContent()}
                    </Animated.ScrollView>


                    {/* FAB */}
                    <TouchableOpacity style={styles.fab}>
                        <Ionicons name="add" size={24} color="#FFF" />
                    </TouchableOpacity>
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    backButton: {
        zIndex: 2,
        position: 'absolute',
        left: 16,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        height: 32,
        width: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerActions: {
        zIndex: 2,
        position: 'absolute',
        right: 16,
        flexDirection: 'row',
        gap: 12,
    },
    headerIconButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 2,
    },
    headerNameOverlay: {
        zIndex: 2,
        position: 'absolute',
        left: 60,
        alignItems: 'flex-start',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: 'white',
        marginBottom: -3,
    },
    headerSubtitle: {
        fontSize: 13,
        color: 'rgba(255, 255, 255, 0.8)',
    },
    banner: {
        position: 'absolute',
        left: 0,
        right: 0,
    },
    scrollView: {
        zIndex: 3,
    },
    profileContainer: {
        backgroundColor: '#000',
    },
    profileContent: {
        paddingHorizontal: 16,
        paddingBottom: 16,
        backgroundColor: '#000',
    },
    avatarRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        marginTop: -30,
        marginBottom: 10,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        borderWidth: 3,
        borderColor: '#000',
    },
    profileActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    notificationButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#2F3336',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
    },
    followButton: {
        paddingHorizontal: 24,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#2F3336',
    },
    followButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: '#FFF',
    },
    profileName: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#FFF',
        marginTop: 10,
        marginBottom: 4,
    },
    profileHandle: {
        fontSize: 15,
        color: '#71767B',
        marginBottom: 12,
    },
    profileBio: {
        fontSize: 15,
        color: '#FFF',
        lineHeight: 20,
        marginBottom: 12,
    },
    profileMeta: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 12,
    },
    metaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 16,
        marginBottom: 4,
    },
    metaText: {
        fontSize: 15,
        color: '#71767B',
        marginLeft: 4,
    },
    linkText: {
        color: '#1D9BF0',
    },
    followStats: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    statItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 20,
    },
    statNumber: {
        fontSize: 15,
        fontWeight: '700',
        color: '#FFF',
        marginRight: 4,
    },
    statLabel: {
        fontSize: 15,
        color: '#71767B',
    },
    followedBy: {
        fontSize: 15,
        color: '#536471',
    },
    tabBarContainer: {
        backgroundColor: '#000',
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    tabBar: {
        flexDirection: 'row',
        backgroundColor: '#000',
    },
    tab: {
        flex: 1,
        paddingVertical: 16,
        alignItems: 'center',
        position: 'relative',
    },
    tabText: {
        fontSize: 15,
        fontWeight: '500',
        color: '#71767B',
    },
    activeTabText: {
        color: '#FFF',
        fontWeight: '700',
    },
    tabIndicator: {
        position: 'absolute',
        bottom: 0,
        width: 30,
        height: 2,
        backgroundColor: '#1D9BF0',
        borderRadius: 1,
    },
    postContainer: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
        backgroundColor: '#000',
    },
    postAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    postContent: {
        flex: 1,
    },
    postHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    postUserName: {
        fontSize: 15,
        fontWeight: '700',
        color: '#FFF',
        marginRight: 4,
    },
    verifiedIcon: {
        marginRight: 4,
    },
    postHandle: {
        fontSize: 15,
        color: '#71767B',
        marginRight: 4,
    },
    postDate: {
        fontSize: 15,
        color: '#71767B',
    },
    postText: {
        fontSize: 15,
        color: '#FFF',
        lineHeight: 20,
        marginBottom: 12,
    },
    postEngagement: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        maxWidth: 300,
    },
    engagementButton: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    engagementText: {
        fontSize: 13,
        color: '#71767B',
        marginLeft: 4,
    },
    communitiesSection: {
        marginTop: 16,
    },
    communityIconImage: {
        flex: 1,
        overflow: 'hidden',
        resizeMode: 'cover',
    },
    communitiesTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#FFF',
        marginBottom: 12,
    },
    communityCard: {
        backgroundColor: '#16181C',
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#2F3336',
    },
    communityHeader: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    communityIcon: {
        width: 100,
        height: 100,
        borderRadius: 8,
        marginRight: 12,
        overflow: 'hidden',
    },
    communityIconGradient: {
        flex: 1,
        backgroundColor: '#1D9BF0',
        borderRadius: 8,
    },
    communityInfo: {
        flex: 1,
    },
    communityName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#FFF',
        marginBottom: 4,
    },
    communityDescription: {
        fontSize: 14,
        color: '#71767B',
        lineHeight: 18,
        marginBottom: 8,
    },
    communityMembers: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    memberAvatars: {
        flexDirection: 'row',
        marginRight: 8,
    },
    memberAvatar: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: '#16181C',
    },
    avatarCircle: {
        flex: 1,
        backgroundColor: '#71767B',
        borderRadius: 10,
    },
    memberCount: {
        fontSize: 13,
        color: '#71767B',
    },
    viewButtonInCard: {
        backgroundColor: 'transparent',
        paddingHorizontal: 16,
        paddingVertical: 6,
        alignSelf: 'center',
        width: "100%",
        textAlign: "center",
        marginTop: 10
    },
    viewButtonText: {
        color: '#1D9BF0',
        fontSize: 15,
        fontWeight: '600',
        textAlign: "center"
    },
    fab: {
        position: 'absolute',
        bottom: 40,
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        zIndex: 1000,
        backgroundColor: '#1D9BF0',
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
    emptyTabView: {
        height: 200,
    },
    mediaGrid: {
        backgroundColor: '#000',
    },
    mediaRow: {
        flexDirection: 'row',
        marginBottom: 2,
    },
    mediaImageContainer: {
        flex: 1,
        marginHorizontal: 1,
    },
    mediaImage: {
        width: '100%',
        aspectRatio: 1,
        backgroundColor: '#2F3336',
    },
    stickyTabBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 1000,
    },
    stickyTabBarContent: {
        flexDirection: 'row',
        backgroundColor: '#000',
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#000',
    },
    loadingText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
    },

});

export default TwitterProfile;