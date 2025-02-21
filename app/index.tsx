import React, { useState, useEffect, useContext } from 'react';
import { StyleSheet, } from 'react-native';
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

export default function HomeScreen() {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    dispatch(fetchTrends());
  }, [dispatch]);

  const isMobile = useMediaQuery({ maxWidth: 500 })

  return (
    <ScrollView>
      <SafeAreaView>
        <Header 
          options={{ 
        title: "Home", 
        leftComponents: [isMobile ? <SessionOwnerButton collapsed={true} /> : null], 
        rightComponents: [<Hashtag />, <Link href="/settings"><Gear /></Link>, <Link href="/login">Login</Link>] 
          }} 
        />
        <Feed />
      </SafeAreaView>
    </ScrollView >
  );
}

const styles = StyleSheet.create({
  container: {},
});
