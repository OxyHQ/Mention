import React, { useState, useEffect, useContext } from 'react';
import { StyleSheet, } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import { Header } from '@/components/Header';
import { fetchTrends } from '@/store/reducers/trendsReducer';
import { Hashtag } from '@/assets/icons/hashtag-icon';
import { Stories } from '@/components/Stories';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';
import Feed from '@/components/Feed';

export default function HomeScreen() {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch(fetchTrends());
  }, [dispatch]);

  return (
    <ScrollView>
      <SafeAreaView>
        <Header options={{ title: "Home", rightComponents: [<Hashtag />] }} />
        <Stories />
        <Feed />
      </SafeAreaView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {},
});
