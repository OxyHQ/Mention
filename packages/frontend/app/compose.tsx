import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';

const ComposeScreen = () => {
  const [postContent, setPostContent] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const { user } = useOxy();
  const { addPost } = usePostsStore();
  const { t } = useTranslation();

  const handlePost = async () => {
    if (!postContent.trim() || isPosting || !user) return;

    setIsPosting(true);
    try {
      console.log('Attempting to create post...');

      // Create new post data for store
      const avatarUrl = typeof user.avatar === 'string'
        ? user.avatar
        : user.avatar?.url || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg';

      const newPostData = {
        user: {
          name: user.name?.full || user.username,
          handle: user.username,
          avatar: avatarUrl,
          verified: user.verified || false,
        },
        content: postContent.trim(),
        engagement: {
          replies: 0,
          reposts: 0,
          likes: 0,
        },
      };

      // Add to store
      addPost(newPostData);

      // Show success toast
      toast.success(t('Post published successfully'));

      // Navigate back after posting
      router.back();
    } catch (error: any) {
      console.error('Error creating post:', error);
      toast.error(t('Failed to publish post'));
    } finally {
      setIsPosting(false);
    }
  };

  const handleCancel = () => {
    router.back();
  };

  const isPostButtonEnabled = postContent.trim().length > 0 && !isPosting;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
          <Text style={styles.cancelButtonText}>{t('Cancel')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handlePost}
          style={[
            styles.postButton,
            !isPostButtonEnabled && styles.postButtonDisabled
          ]}
          disabled={!isPostButtonEnabled}
        >
          {isPosting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.postButtonText}>{t('Post')}</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.composeArea}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
      >
        <View style={styles.userInfoContainer}>
          <Avatar
            size={40}
          />

          <View style={styles.userInfo}>
            <Text style={styles.userName}>{user?.fullName || user?.username}</Text>
            {user?.username && <Text style={styles.userHandle}>@{user.username}</Text>}
          </View>
        </View>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder={t("What's happening?")}
            placeholderTextColor="#657786"
            multiline
            autoFocus
            value={postContent}
            onChangeText={setPostContent}
            maxLength={280}
          />
        </View>

        <View style={styles.charCountContainer}>
          <Text style={[
            styles.charCount,
            postContent.length > 260 && styles.charCountWarning,
            postContent.length >= 280 && styles.charCountLimit
          ]}>
            {280 - postContent.length}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E1E8ED',
  },
  cancelButton: {
    padding: 8,
  },
  cancelButtonText: {
    color: '#1DA1F2',
    fontSize: 16,
  },
  postButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 50,
  },
  postButtonDisabled: {
    backgroundColor: '#9BD1F9',
  },
  postButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  composeArea: {
    flex: 1,
    padding: 16,
  },
  userInfoContainer: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  userInfo: {
    marginLeft: 12,
    justifyContent: 'center',
  },
  userName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14171A',
  },
  userHandle: {
    fontSize: 14,
    color: '#657786',
  },
  inputContainer: {
    flex: 1,
  },
  input: {
    fontSize: 18,
    lineHeight: 24,
    color: '#14171A',
    textAlignVertical: 'top',
  },
  charCountContainer: {
    alignItems: 'flex-end',
    paddingVertical: 8,
  },
  charCount: {
    fontSize: 14,
    color: '#657786',
  },
  charCountWarning: {
    color: '#FFAD1F',
  },
  charCountLimit: {
    color: '#E0245E',
  },
});

export default ComposeScreen;