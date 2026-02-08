import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  FlatList,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useSpacesConfig } from '../context/SpacesConfigContext';
import { useLiveSpace } from '../context/LiveSpaceContext';
import type { Space } from '../types';

const TOPICS = [
  'Technology',
  'Music',
  'Sports',
  'Gaming',
  'News',
  'Politics',
  'Science',
  'Art',
  'Business',
  'Education',
  'Entertainment',
  'Health',
  'Culture',
  'Crypto',
  'AI',
] as const;

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
              <MaterialCommunityIcons
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
                <MaterialCommunityIcons name="calendar" size={20} color={theme.colors.text} />
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
            <MaterialCommunityIcons
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
          <MaterialCommunityIcons name="close" size={20} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          Create Space
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <Scroll
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scrollContent, hideFooter && { paddingBottom: 72 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Title *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
            placeholder="What's your space about?"
            placeholderTextColor={theme.colors.textTertiary}
            value={title}
            onChangeText={setTitle}
            maxLength={100}
          />
          <Text style={[styles.charCount, { color: theme.colors.textTertiary }]}>
            {title.length}/100
          </Text>
        </View>

        <View style={styles.inputSection}>
          <Text style={[styles.label, styles.sectionPadded, { color: theme.colors.text }]}>Topic</Text>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={TOPICS}
            keyExtractor={(item) => item}
            contentContainerStyle={styles.chipList}
            renderItem={({ item }) => {
              const selected = topic === item;
              return (
                <TouchableOpacity
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? theme.colors.primary : theme.colors.backgroundSecondary,
                    },
                  ]}
                  onPress={() => setTopic(selected ? '' : item)}
                >
                  <Text style={[styles.chipText, { color: selected ? '#FFFFFF' : theme.colors.text }]}>
                    {item}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>

        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Description</Text>
          <TextInput
            style={[styles.textArea, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
            placeholder="Tell people what to expect..."
            placeholderTextColor={theme.colors.textTertiary}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
            maxLength={500}
          />
        </View>

        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Who can speak?</Text>
          <View style={styles.radioGroup}>
            {([
              { value: 'everyone' as const, label: 'Everyone', icon: 'earth' as const },
              { value: 'followers' as const, label: 'People you follow', icon: 'account-group-outline' as const },
              { value: 'invited' as const, label: 'Only invited speakers', icon: 'account-plus-outline' as const },
            ]).map((option, index, arr) => {
              const selected = speakerPermission === option.value;
              const isFirst = index === 0;
              const isLast = index === arr.length - 1;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.radioRow,
                    {
                      backgroundColor: theme.colors.backgroundSecondary,
                      borderTopLeftRadius: isFirst ? 12 : 0,
                      borderTopRightRadius: isFirst ? 12 : 0,
                      borderBottomLeftRadius: isLast ? 12 : 0,
                      borderBottomRightRadius: isLast ? 12 : 0,
                    },
                  ]}
                  onPress={() => setSpeakerPermission(option.value)}
                >
                  <MaterialCommunityIcons
                    name={option.icon}
                    size={18}
                    color={selected ? theme.colors.primary : theme.colors.textSecondary}
                  />
                  <Text style={[styles.radioLabel, { color: selected ? theme.colors.primary : theme.colors.text }]}>
                    {option.label}
                  </Text>
                  <View
                    style={[
                      styles.radioCircle,
                      {
                        borderColor: selected ? theme.colors.primary : theme.colors.border,
                        backgroundColor: selected ? theme.colors.primary : 'transparent',
                      },
                    ]}
                  >
                    {selected && (
                      <MaterialCommunityIcons name="check" size={12} color="#FFFFFF" />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {mode === 'standalone' && (
          <View style={[styles.inputSection, styles.sectionPadded]}>
            <Text style={[styles.label, { color: theme.colors.text }]}>Schedule (Optional)</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
              placeholder="e.g., 2024-03-20 14:00"
              placeholderTextColor={theme.colors.textTertiary}
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
  scrollContent: { paddingVertical: 16, paddingBottom: 12 },
  sectionPadded: { paddingHorizontal: 16 },
  inputSection: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  textArea: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  charCount: { fontSize: 11, marginTop: 4 },
  chipList: { gap: 8, paddingHorizontal: 16 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  radioGroup: {
    gap: 3,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  radioLabel: { fontSize: 14, flex: 1 },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: 0.5,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 22,
    gap: 6,
  },
  primaryButtonText: { fontSize: 15, fontWeight: '600' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 22,
    borderWidth: 1,
    gap: 6,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600' },
});

export default CreateSpaceSheet;
