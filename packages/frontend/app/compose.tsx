import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../styles/colors';
import Avatar from '@/components/Avatar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';
import { pollService } from '../services/pollService';

const ComposeScreen = () => {
  const [postContent, setPostContent] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollEndsInDays, setPollEndsInDays] = useState(7); // simple duration control
  const { user } = useOxy();
  const { createPost } = usePostsStore();
  const { t } = useTranslation();

  const validPoll = useMemo(() => {
    if (!showPoll) return true;
    const options = pollOptions.map(o => o.trim()).filter(Boolean);
    return pollQuestion.trim().length > 0 && options.length >= 2;
  }, [showPoll, pollQuestion, pollOptions]);

  const handlePost = async () => {
    if (!postContent.trim() || isPosting || !user) return;
    if (!validPoll) {
      toast.error(t('Please provide a question and at least 2 options'));
      return;
    }

    setIsPosting(true);
    try {
      console.log('Attempting to create post...');

      // Create the post request for the API
      const postRequest = {
        content: {
          text: postContent.trim(),
        },
        mentions: [],
        hashtags: []
      };

      // Send to backend API
      await createPost(postRequest);

      // If poll enabled, create poll linked to the new post
      if (showPoll) {
        try {
          const endsAt = new Date(Date.now() + pollEndsInDays * 24 * 60 * 60 * 1000).toISOString();
          const options = pollOptions.map(o => o.trim()).filter(Boolean);
          // Grab the newest post from store (createPost prepends it)
          const newest = usePostsStore.getState().feeds.posts.items[0] || usePostsStore.getState().feeds.mixed.items[0];
          const postId = newest?.id;
          if (postId) {
            const res = await pollService.createPoll({
              question: pollQuestion.trim(),
              options,
              postId,
              endsAt,
              isMultipleChoice: false,
              isAnonymous: false,
            });
            const pollId = res?.data?._id || res?.data?.id;
            if (pollId) {
              // Optionally reflect locally that post has a poll reference
              try {
                usePostsStore.getState().updatePostLocally(postId, {
                  metadata: {
                    ...(usePostsStore.getState().feeds.posts.items.find(p => p.id === postId)?.metadata || {}),
                    pollId
                  } as any
                } as any);
              } catch {}
            }
          }
        } catch (err) {
          console.error('Failed to create poll for post:', err);
        }
      }

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
  const canAddOption = pollOptions.length < 4;
  const handleAddOption = () => {
    if (canAddOption) setPollOptions(prev => [...prev, '']);
  };
  const handleRemoveOption = (index: number) => {
    setPollOptions(prev => prev.length > 2 ? prev.filter((_, i) => i !== index) : prev);
  };
  const handleChangeOption = (index: number, value: string) => {
    setPollOptions(prev => prev.map((opt, i) => (i === index ? value : opt)));
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
          <Text style={styles.cancelText}>{t('Cancel')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handlePost}
          disabled={!isPostButtonEnabled}
          style={[
            styles.postButton,
            !isPostButtonEnabled && styles.postButtonDisabled
          ]}
        >
          {isPosting ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text style={styles.postButtonText}>{t('Post')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Compose Area */}
      <KeyboardAvoidingView
        style={styles.composeArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.userInfo}>
          <Avatar
            source={user?.avatar}
            size={40}
            verified={user?.verified}
          />
          <View style={styles.userDetails}>
            <Text style={styles.userName}>{user?.name?.full || user?.username}</Text>
            <Text style={styles.userHandle}>@{user?.username}</Text>
          </View>
        </View>

        <TextInput
          style={styles.textInput}
          placeholder={t("What's happening?")}
          placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
          value={postContent}
          onChangeText={setPostContent}
          multiline
          autoFocus
          textAlignVertical="top"
        />

        {/* Poll Composer */}
        <View style={styles.pollContainer}>
          {!showPoll ? (
            <TouchableOpacity style={styles.addPollButton} onPress={() => setShowPoll(true)}>
              <Text style={styles.addPollText}>{t('Add poll')}</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ gap: 12 }}>
              <TextInput
                style={styles.pollQuestion}
                placeholder={t('Ask a question')}
                placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                value={pollQuestion}
                onChangeText={setPollQuestion}
              />

              {pollOptions.map((opt, idx) => (
                <View key={idx} style={styles.pollOptionRow}>
                  <TextInput
                    style={styles.pollOption}
                    placeholder={t('Option {{n}}', { n: idx + 1 })}
                    placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                    value={opt}
                    onChangeText={(v) => handleChangeOption(idx, v)}
                  />
                  {pollOptions.length > 2 && (
                    <TouchableOpacity style={styles.removeOptionBtn} onPress={() => handleRemoveOption(idx)}>
                      <Text style={styles.removeOptionText}>×</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}

              <View style={styles.pollActionsRow}>
                <TouchableOpacity
                  onPress={handleAddOption}
                  disabled={!canAddOption}
                  style={[styles.smallBtn, !canAddOption && styles.smallBtnDisabled]}
                >
                  <Text style={styles.smallBtnText}>{t('Add option')}</Text>
                </TouchableOpacity>

                <View style={{ flex: 1 }} />
                <Text style={styles.endsInLabel}>{t('Ends in')}:</Text>
                <TouchableOpacity style={styles.endsChip} onPress={() => setPollEndsInDays(1)}>
                  <Text style={styles.endsChipText}>1d</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.endsChip} onPress={() => setPollEndsInDays(3)}>
                  <Text style={styles.endsChipText}>3d</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.endsChip, pollEndsInDays === 7 && styles.endsChipActive]} onPress={() => setPollEndsInDays(7)}>
                  <Text style={[styles.endsChipText, pollEndsInDays === 7 && styles.endsChipTextActive]}>7d</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.clearPollBtn} onPress={() => { setShowPoll(false); setPollQuestion(''); setPollOptions(['', '']); }}>
                  <Text style={styles.clearPollText}>{t('Remove')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.characterCount}>
            {postContent.length}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  cancelButton: {
    padding: 8,
  },
  cancelText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  postButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 60,
    alignItems: 'center',
  },
  postButtonDisabled: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_5,
  },
  postButtonText: {
    color: colors.COLOR_BLACK_LIGHT_9,
    fontSize: 16,
    fontWeight: '600',
  },
  composeArea: {
    flex: 1,
    padding: 16,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  userDetails: {
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  userHandle: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginTop: 2,
  },
  textInput: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    color: colors.COLOR_BLACK_LIGHT_1,
    minHeight: 120,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  characterCount: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  pollContainer: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
  },
  addPollButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addPollText: {
    color: colors.COLOR_BLACK_LIGHT_3,
    fontWeight: '600',
  },
  pollQuestion: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_1,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    paddingBottom: 8,
  },
  pollOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pollOption: {
    flex: 1,
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_1,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  removeOptionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeOptionText: {
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 18,
    lineHeight: 18,
  },
  pollActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  smallBtn: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallBtnDisabled: {
    opacity: 0.5,
  },
  smallBtnText: {
    color: colors.COLOR_BLACK_LIGHT_3,
    fontWeight: '600',
    fontSize: 12,
  },
  endsInLabel: {
    color: colors.COLOR_BLACK_LIGHT_4,
    fontSize: 12,
  },
  endsChip: {
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
  },
  endsChipActive: {
    backgroundColor: colors.primaryLight_2,
    borderColor: colors.primaryColor,
  },
  endsChipText: {
    color: colors.COLOR_BLACK_LIGHT_3,
    fontWeight: '600',
    fontSize: 12,
  },
  endsChipTextActive: {
    color: colors.primaryColor,
  },
  clearPollBtn: {
    marginLeft: 8,
  },
  clearPollText: {
    color: colors.busy,
    fontSize: 12,
    fontWeight: '600',
  },
});

export default ComposeScreen;
