import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, ScrollView, Alert } from 'react-native';
import { ThemedView } from '../components/ThemedView';
import { ThemedText } from '../components/ThemedText';
import { fetchData } from '../utils/api';
import useAuth from '../hooks/useAuth';
import { LineChart } from 'react-native-chart-kit';
import { useWindowDimensions } from 'react-native';

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
}

export default function AnalyticsScreen() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('weekly');
  const { user } = useAuth();
  const { width } = useWindowDimensions();

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const data = await fetchData(`analytics?userID=${user?.id}&period=${period}`);
        setAnalytics(data);
      } catch (error) {
        console.error('Error fetching analytics:', error);
        Alert.alert('Network Error', 'Failed to fetch analytics data. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    if (user?.id) {
      fetchAnalytics();
    }
  }, [user?.id, period]);

  if (loading) {
    return (
      <ThemedView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </ThemedView>
    );
  }

  if (!analytics) {
    return (
      <ThemedView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ThemedText>No analytics data available</ThemedText>
      </ThemedView>
    );
  }

  const chartData = {
    labels: analytics.timeSeriesData.map(d => new Date(d.date).toLocaleDateString()),
    datasets: [{
      data: analytics.timeSeriesData.map(d => d.stats.postViews)
    }]
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView>
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
