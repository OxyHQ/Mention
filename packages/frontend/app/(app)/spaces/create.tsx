import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { toast } from 'sonner';

import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { useLiveSpace } from '@/context/LiveSpaceContext';
import { spacesService } from '@/services/spacesService';

const CreateSpaceScreen = () => {
  const theme = useTheme();
  const { joinLiveSpace } = useLiveSpace();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [topic, setTopic] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [speakerPermission, setSpeakerPermission] = useState<'everyone' | 'followers' | 'invited'>('invited');
  const [loading, setLoading] = useState(false);

  const isValid = title.trim().length > 0;

  const handleCreateAndStart = async () => {
    if (!isValid || loading) return;

    setLoading(true);
    try {
      const space = await spacesService.createSpace({
        title: title.trim(),
        description: description.trim() || undefined,
        topic: topic.trim() || undefined,
        speakerPermission,
      });

      if (space) {
        // Start the space immediately
        const started = await spacesService.startSpace(space._id);
        if (started) {
          router.replace('/spaces');
          joinLiveSpace(space._id);
        } else {
          toast.error('Space created but failed to start');
          router.replace(`/spaces/${space._id}`);
        }
      } else {
        toast.error('Failed to create space');
      }
    } catch (error) {
      console.error('Error creating space:', error);
      toast.error('Failed to create space');
    } finally {
      setLoading(false);
    }
  };

  const handleSchedule = async () => {
    if (!isValid || loading) return;

    if (!scheduledStart.trim()) {
      toast.error('Please enter a scheduled start time');
      return;
    }

    setLoading(true);
    try {
      const space = await spacesService.createSpace({
        title: title.trim(),
        description: description.trim() || undefined,
        topic: topic.trim() || undefined,
        scheduledStart: scheduledStart.trim(),
        speakerPermission,
      });

      if (space) {
        router.replace(`/spaces/${space._id}`);
      } else {
        toast.error('Failed to create space');
      }
    } catch (error) {
      console.error('Error creating space:', error);
      toast.error('Failed to create space');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <SEO title="Create Space" description="Create a new audio space" />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: 'Create Space',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder={false}
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.infoCard}>
              <View style={[styles.infoIcon, { backgroundColor: theme.colors.primary }]}>
                <Ionicons name="radio" size={24} color={theme.colors.card} />
              </View>
              <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
                Create a live audio space to have real-time conversations with your audience.
              </Text>
            </View>

            {/* Title Input */}
            <View style={styles.inputSection}>
              <ThemedText type="defaultSemiBold" style={styles.label}>
                Title *
              </ThemedText>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                    color: theme.colors.text,
                  },
                ]}
                placeholder="What's your space about?"
                placeholderTextColor={theme.colors.textSecondary}
                value={title}
                onChangeText={setTitle}
                maxLength={100}
              />
              <Text style={[styles.helperText, { color: theme.colors.textSecondary }]}>
                {title.length}/100
              </Text>
            </View>

            {/* Topic Input */}
            <View style={styles.inputSection}>
              <ThemedText type="defaultSemiBold" style={styles.label}>
                Topic
              </ThemedText>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                    color: theme.colors.text,
                  },
                ]}
                placeholder="e.g., Technology, Music, Sports"
                placeholderTextColor={theme.colors.textSecondary}
                value={topic}
                onChangeText={setTopic}
                maxLength={50}
              />
            </View>

            {/* Description Input */}
            <View style={styles.inputSection}>
              <ThemedText type="defaultSemiBold" style={styles.label}>
                Description
              </ThemedText>
              <TextInput
                style={[
                  styles.textArea,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                    color: theme.colors.text,
                  },
                ]}
                placeholder="Tell people what to expect..."
                placeholderTextColor={theme.colors.textSecondary}
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={4}
                maxLength={500}
              />
              <Text style={[styles.helperText, { color: theme.colors.textSecondary }]}>
                {description.length}/500
              </Text>
            </View>

            {/* Speaker Permission */}
            <View style={styles.inputSection}>
              <ThemedText type="defaultSemiBold" style={styles.label}>
                Speakers
              </ThemedText>
              <Text style={[styles.helperText, { color: theme.colors.textSecondary, marginTop: 0, marginBottom: 12 }]}>
                Who can speak? Current speakers will not be affected.
              </Text>
              {([
                { value: 'everyone' as const, label: 'Everyone' },
                { value: 'followers' as const, label: 'People you follow' },
                { value: 'invited' as const, label: 'Only people you invite to speak' },
              ]).map((option) => (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.radioRow,
                    {
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.card,
                    },
                  ]}
                  onPress={() => setSpeakerPermission(option.value)}
                >
                  <Text style={[styles.radioLabel, { color: theme.colors.text }]}>
                    {option.label}
                  </Text>
                  <View
                    style={[
                      styles.radioCircle,
                      {
                        borderColor: speakerPermission === option.value
                          ? theme.colors.primary
                          : theme.colors.border,
                        backgroundColor: speakerPermission === option.value
                          ? theme.colors.primary
                          : 'transparent',
                      },
                    ]}
                  >
                    {speakerPermission === option.value && (
                      <Ionicons name="checkmark" size={14} color={theme.colors.card} />
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>

            {/* Schedule Input */}
            <View style={styles.inputSection}>
              <ThemedText type="defaultSemiBold" style={styles.label}>
                Schedule (Optional)
              </ThemedText>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                    color: theme.colors.text,
                  },
                ]}
                placeholder="e.g., 2024-03-20 14:00"
                placeholderTextColor={theme.colors.textSecondary}
                value={scheduledStart}
                onChangeText={setScheduledStart}
              />
              <Text style={[styles.helperText, { color: theme.colors.textSecondary }]}>
                Enter a date and time for the space to start
              </Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionsSection}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: isValid ? theme.colors.primary : theme.colors.backgroundSecondary,
                    opacity: loading ? 0.6 : 1,
                  },
                ]}
                onPress={handleCreateAndStart}
                disabled={!isValid || loading}
              >
                <Ionicons
                  name="play"
                  size={20}
                  color={isValid ? theme.colors.card : theme.colors.textSecondary}
                />
                <Text
                  style={[
                    styles.primaryButtonText,
                    { color: isValid ? theme.colors.card : theme.colors.textSecondary },
                  ]}
                >
                  {loading ? 'Creating...' : 'Start Now'}
                </Text>
              </TouchableOpacity>

              {scheduledStart.trim() && (
                <TouchableOpacity
                  style={[
                    styles.secondaryButton,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      borderColor: theme.colors.border,
                      opacity: loading ? 0.6 : 1,
                    },
                  ]}
                  onPress={handleSchedule}
                  disabled={!isValid || loading}
                >
                  <Ionicons name="calendar" size={20} color={theme.colors.text} />
                  <Text style={[styles.secondaryButtonText, { color: theme.colors.text }]}>
                    Schedule Space
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Guidelines */}
            <View style={[styles.guidelinesCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
              <View style={styles.guidelineItem}>
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
                <Text style={[styles.guidelineText, { color: theme.colors.text }]}>
                  Be respectful and welcoming to all participants
                </Text>
              </View>
              <View style={styles.guidelineItem}>
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
                <Text style={[styles.guidelineText, { color: theme.colors.text }]}>
                  Keep conversations on topic and engaging
                </Text>
              </View>
              <View style={styles.guidelineItem}>
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
                <Text style={[styles.guidelineText, { color: theme.colors.text }]}>
                  You can invite speakers and manage participants
                </Text>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  infoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 24,
    gap: 12,
  },
  infoIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  inputSection: {
    marginBottom: 24,
  },
  label: {
    fontSize: 15,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  helperText: {
    fontSize: 13,
    marginTop: 4,
  },
  actionsSection: {
    gap: 12,
    marginBottom: 24,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 24,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 8,
  },
  radioLabel: {
    fontSize: 15,
    flex: 1,
  },
  radioCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guidelinesCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  guidelineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  guidelineText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});

export default CreateSpaceScreen;
