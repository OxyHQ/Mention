import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';
import AnimatedSkeleton from './AnimatedSkeleton';

interface LoadingSkeletonProps {
    count?: number;
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ count = 3 }) => {
    const skeletons = [];

    for (let i = 0; i < count; i++) {
        skeletons.push(
            <View key={`skeleton-${i}`} style={styles.postContainer}>
                <View style={styles.headerContainer}>
                    <AnimatedSkeleton width={40} height={40} borderRadius={20} marginBottom={0} />
                    <View style={styles.headerTextContainer}>
                        <AnimatedSkeleton width={120} height={16} />
                        <AnimatedSkeleton width={100} height={14} />
                    </View>
                </View>
                <View style={styles.contentContainer}>
                    <AnimatedSkeleton width="95%" height={16} />
                    <AnimatedSkeleton width="80%" height={16} />
                </View>
                <View style={styles.mediaPlaceholder}>
                    <AnimatedSkeleton width="100%" height={200} borderRadius={12} />
                </View>
                <View style={styles.actionsContainer}>
                    <AnimatedSkeleton width={80} height={20} />
                    <AnimatedSkeleton width={80} height={20} />
                    <AnimatedSkeleton width={80} height={20} />
                </View>
            </View>
        );
    }

    return <>{skeletons}</>;
};

const styles = StyleSheet.create({
    postContainer: {
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        padding: 16,
    },
    headerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    headerTextContainer: {
        marginLeft: 12,
        flex: 1,
    },
    contentContainer: {
        marginBottom: 12,
    },
    mediaPlaceholder: {
        marginBottom: 12,
    },
    actionsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
});

export default LoadingSkeleton;