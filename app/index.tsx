import React, { useState, useEffect, useContext } from 'react';
import { StyleSheet, TouchableOpacity, Text } from 'react-native';
import { Link } from "expo-router";
import { useMediaQuery } from 'react-responsive'
import { useDispatch } from 'react-redux';
import { Header } from '@/components/Header';
import { fetchTrends } from '@/store/reducers/trendsReducer';
import { Hashtag } from '@/assets/icons/hashtag-icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';
import Feed from '@/components/Feed';
import { Gear } from '@/assets/icons/gear-icon';
import { AppDispatch } from '@/store/store';
import { SessionOwnerButton } from '@/modules/oxyhqservices';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { colors } from '@/styles/colors';

export default function HomeScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);
  const sessionContext = useContext(SessionContext);
  const isAuthenticated = sessionContext?.state?.userId != null;

  useEffect(() => {
    dispatch(fetchTrends());
  }, [dispatch]);

  const isMobile = useMediaQuery({ maxWidth: 500 })

  const handleAuthClick = () => {
    setBottomSheetContent(<AuthBottomSheet />);
    openBottomSheet(true);
  };

  return (
    <ScrollView>
      <SafeAreaView>
        <Header
          options={{
            title: "Home",
            leftComponents: [isMobile ? <SessionOwnerButton collapsed={true} /> : null],
            rightComponents: [
              <Hashtag key="hashtag" />,
              <Link href="/settings" key="settings"><Gear /></Link>,
              !isAuthenticated && (
                <TouchableOpacity key="auth" onPress={handleAuthClick}>
                  <Text style={styles.authText}>Sign In</Text>
                </TouchableOpacity>
              )
            ]
          }}
        />
        <Feed />
      </SafeAreaView>
    </ScrollView >
  );
}

const styles = StyleSheet.create({
  container: {},
  authText: {
    color: colors.primaryColor,
    fontWeight: 'bold',
    fontSize: 14,
  }
});
