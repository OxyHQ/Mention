import React from 'react'
import { View, Text, StyleSheet, FlatList } from 'react-native'
import { CreatePost } from '../components/CreatePost'
import { Header } from '../components/Header'
import Post from '../components/Post'
import { IPost, useStore } from '../store/store'
import { colors } from '../styles/colors'

export default function HomeScreen() {
  const posts = useStore((state) => state.posts)

  const renderItem = React.useCallback(({ item }) => <Post {...item} />, [])
  return (
    <View style={styles.container}>
      <Header options={{ title: "Home" }} />
      <CreatePost style={styles.createPost} />
      <FlatList<IPost>
        data={posts}
        renderItem={renderItem}
        style={styles.flatListStyle}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
  },
  createPost: {
    marginBottom: 15,
    borderBottomWidth: 0.01,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  flatListStyle: {
    borderBottomWidth: 0.01,
    borderTopWidth: 0.01,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
})
