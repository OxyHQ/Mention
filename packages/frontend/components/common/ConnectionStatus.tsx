import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ConnectionState = 'connected' | 'offline' | 'reconnecting';

const ConnectionStatus: React.FC = () => {
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const slideAnim = useRef(new Animated.Value(-60)).current;
  const isVisible = connectionState !== 'connected';
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = Boolean(state.isConnected && state.isInternetReachable !== false);

      if (isConnected) {
        // Clear any pending reconnecting timeout
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
          reconnectTimeout.current = null;
        }
        setConnectionState('connected');
      } else {
        setConnectionState('offline');
        // After 3 seconds of being offline, show "Reconnecting..."
        reconnectTimeout.current = setTimeout(() => {
          setConnectionState((prev) => (prev === 'offline' ? 'reconnecting' : prev));
        }, 3000);
      }
    });

    return () => {
      unsubscribe();
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: isVisible ? 0 : -60,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [isVisible, slideAnim]);

  if (!isVisible) return null;

  const backgroundColor = connectionState === 'offline' ? '#E53935' : '#F57C00';
  const message =
    connectionState === 'offline'
      ? 'No internet connection'
      : 'Reconnecting...';

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor,
          paddingTop: insets.top > 0 ? insets.top : 4,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    paddingBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});

export default ConnectionStatus;
