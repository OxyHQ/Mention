import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, ScrollView, Alert, TouchableOpacity } from 'react-native';
import { ThemedView } from '../components/ThemedView';
import { ThemedText } from '../components/ThemedText';
import { fetchData } from '../utils/api';
import useAuth from '../hooks/useAuth';
import { LineChart } from 'react-native-chart-kit';
import { useWindowDimensions } from 'react-native';
import Avatar from '../components/Avatar';
import { useProfile } from '../modules/oxyhqservices/hooks/useProfile';
import { useRouter } from 'expo-router';
import { OxyProfile } from '../modules/oxyhqservices/types';

interface ViewerData {
  _id: string;
  viewCount: number;
  lastViewed: string;
}

interface InteractionData {
  _id: string;
  interactionCount: number;
  types: string[];
  lastInteracted: string;
}

interface TopPost {
  _id: string;
  text: string;
  created_at: string;
  engagement: number;
  stats: {
    likes: number;
    reposts: number;
    quotes: number;
    replies: number;
    bookmarks: number;
  };
}

interface FollowerStats {
  totalFollowers: number;
  newFollowers: number;
  activeFollowers: number;
}

interface AnalyticsData {
  timeSeriesData: Array<{
    date: string;
    stats: {
      postViews: number;
      profileViews: number;
      engagement: {
        likes: number;
        replies: number;
        reposts: number;
        quotes: number;
        bookmarks: number;
      };
      reach: {
        impressions: number;
        uniqueViewers: number;
      };
    };
  }>;
  aggregate: {
    totalPosts: number;
    totalLikes: number;
    totalReposts: number;
    totalQuotes: number;
    totalBookmarks: number;
    totalReplies: number;
  };
  growth: {
    followers: number;
    following: number;
  };
  viewers: ViewerData[];
  interactions: InteractionData[];
  topPosts: TopPost[];
  followerStats: FollowerStats;
}

export default function AnalyticsScreen() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('weekly');
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState('overview');
  const { getProfile } = useProfile();
  const [profile, setProfile] = useState<OxyProfile | null>(null);
  const [isPremium, setIsPremium] = useState<boolean>(false);
  const router = useRouter();
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    const loadProfile = async () => {
      if (!user?.id) {
        setProfileLoading(false);
        return;
      }
      try {
        setProfileLoading(true);
        const userProfile = await getProfile(user.username);
        if (userProfile) {
          setProfile(userProfile);
        }
      } catch (error) {
        console.error('Error loading profile:', error);
      } finally {
        setProfileLoading(false);
      }
    };
    loadProfile();
  }, [user]);

  useEffect(() => {
    const checkPremiumAccess = () => {
      if (profile?.privacySettings?.analyticsSharing) {
        setIsPremium(true);
      } else {
        setIsPremium(false);
      }
    };

    checkPremiumAccess();
  }, [profile]);

  useEffect(() => {
    const fetchAnalytics = async () => {
      if (!isPremium || profileLoading) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const [overviewData, viewersData, interactionsData, topPostsData, followerData] = await Promise.all([
          fetchData(`analytics?userID=${user?.id}&period=${period}`),
          fetchData(`analytics/viewers?userID=${user?.id}&period=${period}`),
          fetchData(`analytics/interactions?userID=${user?.id}&period=${period}`),
          fetchData(`analytics/top-posts?userID=${user?.id}&period=${period}`),
          fetchData(`analytics/followers?userID=${user?.id}&period=${period}`)
        ]);
        
        setAnalytics({
          ...overviewData,
          viewers: viewersData,
          interactions: interactionsData,
          topPosts: topPostsData,
          followerStats: followerData
        });
      } catch (error: any) {
        if (error?.response?.data?.error === 'PREMIUM_REQUIRED') {
          Alert.alert(
            'Premium Feature',
            'Analytics are only available with a premium subscription.',
            [{ text: 'OK' }]
          );
        } else {
          console.error('Error fetching analytics:', error);
          Alert.alert('Network Error', 'Failed to fetch analytics data. Please try again later.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
  }, [user?.id, period, isPremium, profileLoading]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  if (profileLoading || loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!isPremium) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <ThemedText style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 12 }}>Premium Feature</ThemedText>
        <ThemedText style={{ textAlign: 'center', marginBottom: 20 }}>
          Upgrade to Premium to access detailed analytics about your content performance, audience engagement, and more.
        </ThemedText>
        <TouchableOpacity
          style={{
            backgroundColor: '#007AFF',
            padding: 12,
            borderRadius: 8,
          }}
          onPress={() => {
            // Handle upgrade to premium navigation
            router.push('/settings/premium');
          }}
        >
          <ThemedText style={{ color: '#ffffff', fontWeight: 'bold' }}>Upgrade to Premium</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  if (!analytics) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ThemedText>No analytics data available</ThemedText>
      </View>
    );
  }

  const chartData = {
    labels: analytics.timeSeriesData.map(d => new Date(d.date).toLocaleDateString()),
    datasets: [{
      data: analytics.timeSeriesData.map(d => d.stats.postViews)
    }]
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <View style={{ padding: 16 }}>
            <ThemedText style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 16 }}>Analytics Overview</ThemedText>
            
            {/* Engagement Stats */}
            <View style={{ marginBottom: 24 }}>
              <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>Engagement</ThemedText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <StatBox label="Total Posts" value={analytics.aggregate.totalPosts} />
                <StatBox label="Total Likes" value={analytics.aggregate.totalLikes} />
                <StatBox label="Total Reposts" value={analytics.aggregate.totalReposts} />
                <StatBox label="Total Replies" value={analytics.aggregate.totalReplies} />
              </View>
            </View>

            {/* Growth Stats */}
            <View style={{ marginBottom: 24 }}>
              <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>Growth</ThemedText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                <StatBox label="Followers" value={analytics.growth.followers} />
                <StatBox label="Following" value={analytics.growth.following} />
              </View>
            </View>

            {/* Views Chart */}
            <View style={{ marginBottom: 24 }}>
              <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>Post Views Trend</ThemedText>
              <LineChart
                data={chartData}
                width={width - 32}
                height={220}
                chartConfig={{
                  backgroundColor: '#ffffff',
                  backgroundGradientFrom: '#ffffff',
                  backgroundGradientTo: '#ffffff',
                  decimalPlaces: 0,
                  color: (opacity = 1) => `rgba(0, 0, 0, ${opacity})`,
                }}
                bezier
                style={{ marginVertical: 8, borderRadius: 16 }}
              />
            </View>
          </View>
        );
      case 'viewers':
        return (
          <View style={{ padding: 16 }}>
            <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>Content Viewers</ThemedText>
            {analytics.viewers.map((viewer) => (
              <View key={viewer._id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Avatar size={40} id={viewer._id} />
                <View style={{ marginLeft: 12 }}>
                  <ThemedText style={{ fontWeight: 'bold' }}>{viewer._id}</ThemedText>
                  <ThemedText>{viewer.viewCount} views • Last viewed {new Date(viewer.lastViewed).toLocaleDateString()}</ThemedText>
                </View>
              </View>
            ))}
          </View>
        );
      case 'interactions':
        return (
          <View style={{ padding: 16 }}>
            <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>Interactions</ThemedText>
            {analytics.interactions.map((interaction) => (
              <View key={interaction._id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Avatar size={40} id={interaction._id} />
                <View style={{ marginLeft: 12 }}>
                  <ThemedText style={{ fontWeight: 'bold' }}>{interaction._id}</ThemedText>
                  <ThemedText>{interaction.interactionCount} interactions • {interaction.types.join(', ')}</ThemedText>
                </View>
              </View>
            ))}
          </View>
        );
      case 'top-posts':
        return (
          <View style={{ padding: 16 }}>
            <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>Top Posts</ThemedText>
            {analytics.topPosts.map((post) => (
              <View key={post._id} style={{ padding: 12, backgroundColor: '#f0f0f0', borderRadius: 8, marginBottom: 12 }}>
                <ThemedText>{post.text}</ThemedText>
                <View style={{ flexDirection: 'row', marginTop: 8, justifyContent: 'space-between' }}>
                  <ThemedText>💫 {post.engagement} engagement</ThemedText>
                  <ThemedText>{new Date(post.created_at).toLocaleDateString()}</ThemedText>
                </View>
              </View>
            ))}
          </View>
        );
      case 'followers':
        return (
          <View style={{ padding: 16 }}>
            <ThemedText style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>Follower Details</ThemedText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <StatBox label="Total Followers" value={analytics.followerStats.totalFollowers} />
              <StatBox label="New Followers" value={analytics.followerStats.newFollowers} />
              <StatBox label="Active Followers" value={analytics.followerStats.activeFollowers} />
            </View>
          </View>
        );
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' }}>
        {['overview', 'viewers', 'interactions', 'top-posts', 'followers'].map((tab) => (
          <TouchableOpacity
            key={tab}
            onPress={() => handleTabChange(tab)}
            style={{
              marginRight: 16,
              paddingBottom: 8,
              borderBottomWidth: 2,
              borderBottomColor: activeTab === tab ? '#007AFF' : 'transparent'
            }}
          >
            <ThemedText style={{ color: activeTab === tab ? '#007AFF' : undefined }}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </ThemedText>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView>
        {analytics && renderTabContent()}
      </ScrollView>
    </View>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ 
      backgroundColor: '#f0f0f0', 
      padding: 16, 
      borderRadius: 8,
      marginBottom: 8,
      width: '48%'
    }}>
      <ThemedText style={{ fontSize: 16, fontWeight: 'bold' }}>{value}</ThemedText>
      <ThemedText style={{ fontSize: 14 }}>{label}</ThemedText>
    </View>
  );
}
