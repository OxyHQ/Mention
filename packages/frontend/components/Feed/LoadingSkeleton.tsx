import React from 'react';
import { View, StyleSheet, useWindowDimensions, Platform } from 'react-native';
import { colors } from '@/styles/colors';
import AnimatedSkeleton from './AnimatedSkeleton';

interface LoadingSkeletonProps {
    count?: number;
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ count = 3 }) => {
    const { width: windowWidth } = useWindowDimensions();
    const isTabletOrDesktop = windowWidth >= 768;
    
    const skeletons = [];

    for (let i = 0; i < count; i++) {
        skeletons.push(
            <View key={`skeleton-${i}`} style={[
                styles.postContainer,
                isTabletOrDesktop && styles.postContainerTablet
            ]}>
                <View style={styles.headerContainer}>
                    <AnimatedSkeleton width={40} height={40} borderRadius={20} marginBottom={0} />
                    <View style={styles.headerTextContainer}>
                        <AnimatedSkeleton width={120} height={16} />
                        <AnimatedSkeleton width={100} height={14} />
                    </View>
                    <AnimatedSkeleton width={24} height={24} borderRadius={12} marginBottom={0} />
                </View>
                <View style={styles.contentContainer}>
                    <AnimatedSkeleton width="95%" height={16} />
                    <AnimatedSkeleton width="80%" height={16} />
                    <AnimatedSkeleton width="60%" height={16} />
                </View>
                {i % 2 === 0 && (
                    <View style={styles.mediaPlaceholder}>
                        <AnimatedSkeleton width="100%" height={isTabletOrDesktop ? 300 : 200} borderRadius={12} />
                    </View>
                )}
                <View style={styles.actionsContainer}>
                    <AnimatedSkeleton width={70} height={24} borderRadius={12} />
                    <AnimatedSkeleton width={70} height={24} borderRadius={12} />
                    <AnimatedSkeleton width={70} height={24} borderRadius={12} />
                    <AnimatedSkeleton width={70} height={24} borderRadius={12} />
                </View>
            </View>
        );

        if (i < count - 1) {
            skeletons.push(
                <View key={`separator-${i}`} style={styles.separator} />
            );
        }
    }

    return <>{skeletons}</>;
};

const styles = StyleSheet.create({
    postContainer: {
        backgroundColor: 'white',
        padding: 16,
        borderRadius: 8,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    postContainerTablet: {
        padding: 24,
        borderRadius: 12,
        marginHorizontal: Platform.OS === 'web' ? 0 : 16,
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 3,
    },
    headerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    headerTextContainer: {
        marginLeft: 12,
        flex: 1,
    },
    contentContainer: {
        marginBottom: 16,
    },
    mediaPlaceholder: {
        marginBottom: 16,
        borderRadius: 12,
        overflow: 'hidden',
    },
    actionsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingTop: 8,
    },
    separator: {
        height: 6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
});

export default LoadingSkeleton;

export default LoadingSkeleton;