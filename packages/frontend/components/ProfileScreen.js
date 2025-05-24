"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ProfileScreen;
var vector_icons_1 = require("@expo/vector-icons");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var expo_status_bar_1 = require("expo-status-bar");
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var Feed_1 = require("./Feed");
function ProfileScreen() {
    var _this = this;
    var _a = (0, services_1.useOxy)(), currentUser = _a.user, logout = _a.logout, oxyServices = _a.oxyServices, showBottomSheet = _a.showBottomSheet;
    var username = (0, expo_router_1.useLocalSearchParams)().username;
    if (username && username.startsWith('@')) {
        username = username.slice(1);
    }
    var _b = (0, react_1.useState)(null), profileData = _b[0], setProfileData = _b[1];
    var _c = (0, react_1.useState)(false), isLoading = _c[0], setIsLoading = _c[1];
    var _d = (0, react_1.useState)(null), error = _d[0], setError = _d[1];
    var _e = (0, react_1.useState)(true), isCurrentUser = _e[0], setIsCurrentUser = _e[1];
    var _f = (0, react_1.useState)('posts'), activeTab = _f[0], setActiveTab = _f[1]; // For Twitter-like content tabs
    var fetchProfileData = (0, react_1.useCallback)(function (username) { return __awaiter(_this, void 0, void 0, function () {
        var data, userData, fullName, firstName, lastName, err_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, 3, 4]);
                    setIsLoading(true);
                    setError(null);
                    return [4 /*yield*/, oxyServices.getProfileByUsername(username)];
                case 1:
                    data = _c.sent();
                    console.log('Fetched profile data:', data);
                    userData = data;
                    fullName = '';
                    if (userData.name) {
                        firstName = userData.name.first || '';
                        lastName = userData.name.last || '';
                        fullName = [firstName, lastName].filter(Boolean).join(' ');
                    }
                    setProfileData({
                        id: userData._id || userData.id,
                        username: userData.username,
                        profilePicture: userData.profilePicture || userData.avatar,
                        coverPhoto: userData.coverPhoto || 'https://pbs.twimg.com/profile_banners/44196397/1576183471/1500x500', // Default cover
                        email: userData.email,
                        createdAt: userData.createdAt,
                        fullName: fullName,
                        description: userData.description || userData.bio,
                        followersCount: (_a = userData._count) === null || _a === void 0 ? void 0 : _a.followers,
                        followingCount: (_b = userData._count) === null || _b === void 0 ? void 0 : _b.following,
                        location: userData.location
                    });
                    return [3 /*break*/, 4];
                case 2:
                    err_1 = _c.sent();
                    console.error('Error fetching profile:', err_1);
                    setError(err_1.message || 'Failed to load profile');
                    return [3 /*break*/, 4];
                case 3:
                    setIsLoading(false);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    }); }, [oxyServices]);
    // Fetch profile data if viewing another user
    (0, react_1.useEffect)(function () {
        if (username && username !== (currentUser === null || currentUser === void 0 ? void 0 : currentUser.username)) {
            setIsCurrentUser(false);
            fetchProfileData(username);
        }
        else {
            // Use current user data
            setIsCurrentUser(true);
            if (currentUser) {
                setProfileData(currentUser);
            }
        }
    }, [username, currentUser, fetchProfileData]);
    // Handle tab selection
    var handleTabPress = function (tab) {
        setActiveTab(tab);
    };
    // Loading state
    if (isLoading) {
        return (<react_native_1.View style={styles.loadingContainer}>
                <react_native_1.ActivityIndicator size="large" color="#1DA1F2"/>
                <react_native_1.Text style={styles.loadingText}>Loading profile...</react_native_1.Text>
            </react_native_1.View>);
    }
    // Error state
    if (error) {
        return (<react_native_1.View style={styles.errorContainer}>
                <vector_icons_1.Ionicons name="warning-outline" size={60} color="#ff6b6b"/>
                <react_native_1.Text style={styles.errorText}>{error}</react_native_1.Text>
                <react_native_1.TouchableOpacity style={styles.backButton} onPress={function () { return expo_router_1.router.back(); }}>
                    <react_native_1.Text style={styles.backButtonText}>Go Back</react_native_1.Text>
                </react_native_1.TouchableOpacity>
            </react_native_1.View>);
    }
    return (<react_native_safe_area_context_1.SafeAreaView style={styles.container} edges={['top']}>
            <expo_status_bar_1.StatusBar style="dark"/>
            <react_native_1.View style={styles.navigationHeader}>
                <react_native_1.TouchableOpacity style={styles.backButtonSmall} onPress={function () { return expo_router_1.router.back(); }}>
                    <vector_icons_1.Ionicons name="arrow-back" size={22} color="#000"/>
                </react_native_1.TouchableOpacity>
                <react_native_1.Text style={styles.headerTitle}>
                    {(profileData === null || profileData === void 0 ? void 0 : profileData.fullName) || (profileData === null || profileData === void 0 ? void 0 : profileData.username) || 'Profile'}
                </react_native_1.Text>
            </react_native_1.View>

            <react_native_1.ScrollView style={styles.scrollView}>
                {/* Cover photo banner */}
                <react_native_1.View style={styles.coverPhotoContainer}>
                    <react_native_1.Image source={{ uri: (profileData === null || profileData === void 0 ? void 0 : profileData.coverPhoto) || 'https://pbs.twimg.com/profile_banners/44196397/1576183471/1500x500' }} style={styles.coverPhoto}/>
                </react_native_1.View>

                {/* Profile section with avatar overlapping the banner */}
                <react_native_1.View style={styles.profileSection}>
                    <services_1.Avatar uri={profileData === null || profileData === void 0 ? void 0 : profileData.profilePicture} size={100} style={styles.profileAvatar}/>

                    {/* Follow/Edit Profile button */}
                    <react_native_1.View style={styles.profileActionContainer}>
                        {isCurrentUser ? (<react_native_1.TouchableOpacity style={styles.editProfileButton} onPress={function () { return showBottomSheet === null || showBottomSheet === void 0 ? void 0 : showBottomSheet('AccountCenter'); }}>
                                <react_native_1.Text style={styles.editProfileButtonText}>Edit Profile</react_native_1.Text>
                            </react_native_1.TouchableOpacity>) : (profileData === null || profileData === void 0 ? void 0 : profileData.id) ? (<services_1.FollowButton userId={profileData.id} size="small"/>) : null}
                    </react_native_1.View>

                    {/* Profile info */}
                    <react_native_1.View style={styles.profileInfo}>
                        <react_native_1.Text style={styles.fullName}>{(profileData === null || profileData === void 0 ? void 0 : profileData.fullName) || 'User'}</react_native_1.Text>
                        <react_native_1.Text style={styles.username}>@{profileData === null || profileData === void 0 ? void 0 : profileData.username}</react_native_1.Text>
                        
                        {(profileData === null || profileData === void 0 ? void 0 : profileData.description) && (<react_native_1.Text style={styles.bio}>{profileData.description}</react_native_1.Text>)}

                        {/* Location and join date */}
                        <react_native_1.View style={styles.profileMetaInfo}>
                            {(profileData === null || profileData === void 0 ? void 0 : profileData.location) && (<react_native_1.View style={styles.metaItem}>
                                    <vector_icons_1.Ionicons name="location-outline" size={16} color="#657786"/>
                                    <react_native_1.Text style={styles.metaText}>{profileData.location}</react_native_1.Text>
                                </react_native_1.View>)}
                            
                            {(profileData === null || profileData === void 0 ? void 0 : profileData.createdAt) && (<react_native_1.View style={styles.metaItem}>
                                    <vector_icons_1.Ionicons name="calendar-outline" size={16} color="#657786"/>
                                    <react_native_1.Text style={styles.metaText}>
                                        Joined {new Date(profileData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                                    </react_native_1.Text>
                                </react_native_1.View>)}
                        </react_native_1.View>

                        {/* Followers/Following counts */}
                        <react_native_1.View style={styles.followStats}>
                            <react_native_1.TouchableOpacity style={styles.statItem} onPress={function () { return expo_router_1.router.push("/".concat(profileData === null || profileData === void 0 ? void 0 : profileData.username, "/following")); }}>
                                <react_native_1.Text style={styles.statValue}>{(profileData === null || profileData === void 0 ? void 0 : profileData.followingCount) || 0}</react_native_1.Text>
                                <react_native_1.Text style={styles.statLabel}>Following</react_native_1.Text>
                            </react_native_1.TouchableOpacity>
                            
                            <react_native_1.TouchableOpacity style={styles.statItem} onPress={function () { return expo_router_1.router.push("/".concat(profileData === null || profileData === void 0 ? void 0 : profileData.username, "/followers")); }}>
                                <react_native_1.Text style={styles.statValue}>{(profileData === null || profileData === void 0 ? void 0 : profileData.followersCount) || 0}</react_native_1.Text>
                                <react_native_1.Text style={styles.statLabel}>Followers</react_native_1.Text>
                            </react_native_1.TouchableOpacity>
                        </react_native_1.View>
                    </react_native_1.View>

                    {/* Twitter-like content tabs */}
                    <react_native_1.View style={styles.tabsContainer}>
                        <react_native_1.TouchableOpacity style={[styles.tab, activeTab === 'posts' ? styles.activeTab : {}]} onPress={function () { return handleTabPress('posts'); }}>
                            <react_native_1.Text style={[styles.tabText, activeTab === 'posts' ? styles.activeTabText : {}]}>Posts</react_native_1.Text>
                        </react_native_1.TouchableOpacity>
                        
                        <react_native_1.TouchableOpacity style={[styles.tab, activeTab === 'replies' ? styles.activeTab : {}]} onPress={function () { return handleTabPress('replies'); }}>
                            <react_native_1.Text style={[styles.tabText, activeTab === 'replies' ? styles.activeTabText : {}]}>Replies</react_native_1.Text>
                        </react_native_1.TouchableOpacity>
                        
                        <react_native_1.TouchableOpacity style={[styles.tab, activeTab === 'media' ? styles.activeTab : {}]} onPress={function () { return handleTabPress('media'); }}>
                            <react_native_1.Text style={[styles.tabText, activeTab === 'media' ? styles.activeTabText : {}]}>Media</react_native_1.Text>
                        </react_native_1.TouchableOpacity>
                        
                        <react_native_1.TouchableOpacity style={[styles.tab, activeTab === 'likes' ? styles.activeTab : {}]} onPress={function () { return handleTabPress('likes'); }}>
                            <react_native_1.Text style={[styles.tabText, activeTab === 'likes' ? styles.activeTabText : {}]}>Likes</react_native_1.Text>
                        </react_native_1.TouchableOpacity>
                    </react_native_1.View>
                </react_native_1.View>

                {/* Content area based on selected tab */}
                <react_native_1.View style={styles.contentArea}>
                    {activeTab === 'posts' && (<Feed_1.default type="posts" parentId={profileData === null || profileData === void 0 ? void 0 : profileData.id}/>)}

                    {activeTab === 'replies' && (<Feed_1.default type="replies" parentId={profileData === null || profileData === void 0 ? void 0 : profileData.id}/>)}

                    {activeTab === 'media' && (<Feed_1.default type="media" parentId={profileData === null || profileData === void 0 ? void 0 : profileData.id}/>)}

                    {activeTab === 'likes' && (<react_native_1.View style={styles.emptyStateContainer}>
                            <vector_icons_1.Ionicons name="heart-outline" size={40} color="#657786"/>
                            <react_native_1.Text style={styles.emptyStateTitle}>No Likes Yet</react_native_1.Text>
                            <react_native_1.Text style={styles.emptyStateText}>Posts {isCurrentUser ? 'you have' : 'they have'} liked will show up here.</react_native_1.Text>
                        </react_native_1.View>)}
                </react_native_1.View>
            </react_native_1.ScrollView>
        </react_native_safe_area_context_1.SafeAreaView>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    scrollView: {
        flex: 1,
        backgroundColor: '#fff',
    },
    // Twitter-style navigation header
    navigationHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: '#E1E8ED',
        backgroundColor: '#fff',
    },
    backButtonSmall: {
        padding: 8,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginLeft: 16,
        color: '#14171A',
    },
    // Cover photo
    coverPhotoContainer: {
        height: 150,
        width: '100%',
        backgroundColor: '#AAB8C2',
    },
    coverPhoto: {
        height: '100%',
        width: '100%',
        resizeMode: 'cover',
    },
    // Profile section
    profileSection: {
        paddingBottom: 10,
    },
    profileAvatar: {
        marginTop: -40,
        marginLeft: 16,
        borderWidth: 5,
        borderColor: '#fff',
    },
    profileActionContainer: {
        position: 'absolute',
        right: 16,
        top: 10,
    },
    editProfileButton: {
        borderWidth: 1,
        borderColor: '#1DA1F2',
        borderRadius: 50,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    editProfileButtonText: {
        color: '#1DA1F2',
        fontWeight: '600',
        fontSize: 14,
    },
    followButton: {
        backgroundColor: '#1DA1F2',
        borderRadius: 50,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    followingButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: '#1DA1F2',
    },
    followButtonText: {
        color: '#fff',
        fontWeight: '600',
        fontSize: 14,
    },
    followingButtonText: {
        color: '#1DA1F2',
    },
    // Profile info
    profileInfo: {
        padding: 16,
    },
    fullName: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#14171A',
    },
    username: {
        fontSize: 15,
        color: '#657786',
        marginBottom: 10,
    },
    bio: {
        fontSize: 15,
        color: '#14171A',
        marginBottom: 12,
        lineHeight: 20,
    },
    profileMetaInfo: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 12,
    },
    metaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 16,
        marginBottom: 6,
    },
    metaText: {
        fontSize: 14,
        color: '#657786',
        marginLeft: 4,
    },
    // Follow stats
    followStats: {
        flexDirection: 'row',
        marginTop: 4,
    },
    statItem: {
        flexDirection: 'row',
        marginRight: 16,
    },
    statValue: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#14171A',
        marginRight: 4,
    },
    statLabel: {
        fontSize: 14,
        color: '#657786',
    },
    // Tabs
    tabsContainer: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: '#E1E8ED',
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 16,
    },
    activeTab: {
        borderBottomWidth: 2,
        borderBottomColor: '#1DA1F2',
    },
    tabText: {
        color: '#657786',
        fontWeight: '500',
    },
    activeTabText: {
        color: '#1DA1F2',
        fontWeight: 'bold',
    },
    // Content area
    contentArea: {
        minHeight: 300,
    },
    emptyStateContainer: {
        padding: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyStateTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#14171A',
        marginTop: 10,
        marginBottom: 8,
    },
    emptyStateText: {
        fontSize: 15,
        color: '#657786',
        textAlign: 'center',
    },
    // Loading state
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    loadingText: {
        fontSize: 16,
        marginTop: 12,
        color: '#657786',
    },
    // Error state
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    errorText: {
        fontSize: 16,
        marginTop: 12,
        color: '#ff6b6b',
        textAlign: 'center',
        marginBottom: 20,
    },
    backButton: {
        backgroundColor: '#1DA1F2',
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 50,
        marginTop: 16,
    },
    backButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
});
