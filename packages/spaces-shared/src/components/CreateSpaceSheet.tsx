import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useSpacesConfig } from '../context/SpacesConfigContext';
import { useLiveSpace } from '../context/LiveSpaceContext';
import type { Space } from '../types';

export interface CreateSpaceSheetRef {
  handleCreateAndStart: () => void;
  handleSchedule: () => void;
  handleCreateForEmbed: () => void;
}

export interface CreateSpaceFormState {
  isValid: boolean;
  loading: boolean;
  hasScheduledStart: boolean;
}

interface CreateSpaceSheetProps {
  onClose: () => void;
  onSpaceCreated?: (space: Space) => void;
  mode?: 'standalone' | 'embed';
  ScrollViewComponent?: React.ComponentType<any>;
  hideFooter?: boolean;
  onFormStateChange?: (state: CreateSpaceFormState) => void;
}

export const CreateSpaceSheet = forwardRef<CreateSpaceSheetRef, CreateSpaceSheetProps>(({
  onClose,
  onSpaceCreated,
  mode = 'standalone',
  ScrollViewComponent,
  hideFooter = false,
  onFormStateChange,
}, ref) => {
  const Scroll = ScrollViewComponent || ScrollView;
  const { useTheme, spacesService, toast } = useSpacesConfig();
  const theme = useTheme();
  const { joinLiveSpace } = useLiveSpace();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [topic, setTopic] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [speakerPermission, setSpeakerPermission] = useState<'everyone' | 'followers' | 'invited'>('invited');
  const [loading, setLoading] = useState(false);

  const isValid = title.trim().length > 0;

  useEffect(() => {
    onFormStateChange?.({ isValid, loading, hasScheduledStart: !!scheduledStart.trim() });
  }, [isValid, loading, scheduledStart, onFormStateChange]);

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
        const started = await spacesService.startSpace(space._id);
        onClose();
        if (started) {
          joinLiveSpace(space._id);
        } else {
          toast.error('Space created but failed to start');
        }
        onSpaceCreated?.(space);
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
        onClose();
        onSpaceCreated?.(space);
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

  const handleCreateForEmbed = async () => {
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
        onClose();
        onSpaceCreated?.(space);
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

  useImperativeHandle(ref, () => ({
    handleCreateAndStart,
    handleSchedule,
    handleCreateForEmbed,
  }), [handleCreateAndStart, handleSchedule, handleCreateForEmbed]);

  const renderFooterContent = () => {
    if (hideFooter) return null;
    return (
      <View style={[styles.footer, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        {mode === 'standalone' ? (
          <>
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
                style={[styles.primaryButtonText, { color: isValid ? theme.colors.card : theme.colors.textSecondary }]}
              >
                {loading ? 'Creating...' : 'Start Now'}
              </Text>
            </TouchableOpacity>

            {scheduledStart.trim() && (
              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border, opacity: loading ? 0.6 : 1 },
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
          </>
        ) : (
          <TouchableOpacity
            style={[
              styles.primaryButton,
              {
                backgroundColor: isValid ? theme.colors.primary : theme.colors.backgroundSecondary,
                opacity: loading ? 0.6 : 1,
              },
            ]}
            onPress={handleCreateForEmbed}
            disabled={!isValid || loading}
          >
            <Ionicons
              name="radio"
              size={20}
              color={isValid ? theme.colors.card : theme.colors.textSecondary}
            />
            <Text
              style={[styles.primaryButtonText, { color: isValid ? theme.colors.card : theme.colors.textSecondary }]}
            >
              {loading ? 'Creating...' : 'Create Space'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={onClose} style={styles.headerCloseBtn}>
          <Ionicons name="close" size={20} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          Create Space
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <Scroll
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.inputSection}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Title *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
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

        <View style={styles.inputSection}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Topic</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="e.g., Technology, Music, Sports"
            placeholderTextColor={theme.colors.textSecondary}
            value={topic}
            onChangeText={setTopic}
            maxLength={50}
          />
        </View>

        <View style={styles.inputSection}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Description</Text>
          <TextInput
            style={[styles.textArea, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="Tell people what to expect..."
            placeholderTextColor={theme.colors.textSecondary}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
            maxLength={500}
          />
        </View>

        <View style={styles.inputSection}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Speakers</Text>
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
              style={[styles.radioRow, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
              onPress={() => setSpeakerPermission(option.value)}
            >
              <Text style={[styles.radioLabel, { color: theme.colors.text }]}>
                {option.label}
              </Text>
              <View
                style={[
                  styles.radioCircle,
                  {
                    borderColor: speakerPermission === option.value ? theme.colors.primary : theme.colors.border,
                    backgroundColor: speakerPermission === option.value ? theme.colors.primary : 'transparent',
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

        {mode === 'standalone' && (
          <View style={styles.inputSection}>
            <Text style={[styles.label, { color: theme.colors.text }]}>Schedule (Optional)</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
              placeholder="e.g., 2024-03-20 14:00"
              placeholderTextColor={theme.colors.textSecondary}
              value={scheduledStart}
              onChangeText={setScheduledStart}
            />
          </View>
        )}
      </Scroll>

      {renderFooterContent()}
    </View>
  );
});

CreateSpaceSheet.displayName = 'CreateSpaceSheet';

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
  },
  headerCloseBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  scrollContent: { padding: 16, paddingBottom: 16 },
  inputSection: { marginBottom: 20 },
  label: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
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
    minHeight: 80,
    textAlignVertical: 'top',
  },
  helperText: { fontSize: 13, marginTop: 4 },
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
  radioLabel: { fontSize: 15, flex: 1 },
  radioCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 0.5,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 24,
    gap: 8,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
  },
  secondaryButtonText: { fontSize: 16, fontWeight: '600' },
});

export default CreateSpaceSheet;
