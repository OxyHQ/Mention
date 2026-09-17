import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { useSafeBack } from '@/hooks/useSafeBack';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';

export default function NotFoundScreen() {
    const safeBack = useSafeBack();

    return (
        <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
            <View style={styles.container}>
                {/* Illustration */}
                <View style={styles.illustrationWrap}>
                    <NoUpdatesIllustration width={200} height={200} />
                </View>

                {/* Title */}
                <Text className="text-foreground" style={styles.title}>Page Not Found</Text>

                {/* Message */}
                <Text className="text-muted-foreground" style={styles.message}>
                    The page you&apos;re looking for doesn&apos;t exist or has been moved.
                </Text>

                {/* Buttons */}
                <View style={styles.buttonsContainer}>
                    <Button variant="primary" onPress={safeBack}>
                        Go Back
                    </Button>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    illustrationWrap: {
        width: 220,
        height: 220,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 12,
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        lineHeight: 24,
        marginBottom: 32,
        maxWidth: 320,
    },
    buttonsContainer: {
        width: '100%',
        maxWidth: 320,
        gap: 12,
    },
});
