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

import { useAgoraConfig } from '../context/AgoraConfigContext';
import { useLiveRoom } from '../context/LiveRoomContext';
import type { Room, House } from '../types';

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

const ROOM_TYPES = [
  { value: 'talk' as const, label: 'Talk', icon: 'microphone' as const, description: 'Open conversation' },
  { value: 'stage' as const, label: 'Stage', icon: 'account-voice' as const, description: 'Panel discussion' },
  { value: 'broadcast' as const, label: 'Broadcast', icon: 'broadcast' as const, description: 'One-to-many stream' },
] as const;

export interface CreateRoomSheetRef {
  handleCreateAndStart: () => void;
  handleSchedule: () => void;
  handleCreateForEmbed: () => void;
}

export interface CreateRoomFormState {
  isValid: boolean;
  loading: boolean;
  hasScheduledStart: boolean;
}

interface CreateRoomSheetProps {
  onClose: () => void;
  onRoomCreated?: (room: Room) => void;
  mode?: 'standalone' | 'embed';
  ScrollViewComponent?: React.ComponentType<{ children: React.ReactNode }>;
  hideFooter?: boolean;
  onFormStateChange?: (state: CreateRoomFormState) => void;
  houses?: House[];
}

export const CreateRoomSheet = forwardRef<CreateRoomSheetRef, CreateRoomSheetProps>(({
  onClose,
  onRoomCreated,
  mode = 'standalone',
  ScrollViewComponent,
  hideFooter = false,
  onFormStateChange,
  houses,
}, ref) => {
  const Scroll = ScrollViewComponent || ScrollView;
  const { useTheme, agoraService, toast } = useAgoraConfig();
  const theme = useTheme();
  const { joinLiveRoom } = useLiveRoom();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [topic, setTopic] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [speakerPermission, setSpeakerPermission] = useState<'everyone' | 'followers' | 'invited'>('invited');
  const [roomType, setRoomType] = useState<'talk' | 'stage' | 'broadcast'>('talk');
  const [selectedHouse, setSelectedHouse] = useState<House | null>(null);
  const [loading, setLoading] = useState(false);

  const isValid = title.trim().length > 0;
  const isBroadcast = roomType === 'broadcast';

  useEffect(() => {
    onFormStateChange?.({ isValid, loading, hasScheduledStart: !!scheduledStart.trim() });
  }, [isValid, loading, scheduledStart, onFormStateChange]);

  const buildCreatePayload = () => ({
    title: title.trim(),
    description: description.trim() || undefined,
    topic: topic.trim() || undefined,
    speakerPermission: isBroadcast ? 'invited' as const : speakerPermission,
    type: roomType,
    ownerType: selectedHouse ? 'house' as const : 'profile' as const,
    houseId: selectedHouse?._id,
  });

  const handleCreateAndStart = async () => {
    if (!isValid || loading) return;

    setLoading(true);
    try {
      const room = await agoraService.createRoom(buildCreatePayload());

      if (room) {
        const started = await agoraService.startRoom(room._id);
        onClose();
        if (started) {
          joinLiveRoom(room._id);
        } else {
          toast.error('Room created but failed to start');
        }
        onRoomCreated?.(room);
      } else {
        toast.error('Failed to create room');
      }
    } catch (error) {
      console.error('Error creating room:', error);
      toast.error('Failed to create room');
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
      const room = await agoraService.createRoom({
        ...buildCreatePayload(),
        scheduledStart: scheduledStart.trim(),
      });

      if (room) {
        onClose();
        onRoomCreated?.(room);
      } else {
        toast.error('Failed to create room');
      }
    } catch (error) {
      console.error('Error creating room:', error);
      toast.error('Failed to create room');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateForEmbed = async () => {
    if (!isValid || loading) return;

    setLoading(true);
    try {
      const room = await agoraService.createRoom(buildCreatePayload());

      if (room) {
        onClose();
        onRoomCreated?.(room);
      } else {
        toast.error('Failed to create room');
      }
    } catch (error) {
      console.error('Error creating room:', error);
      toast.error('Failed to create room');
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
                  Schedule Room
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
              {loading ? 'Creating...' : 'Create Room'}
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
          Create Room
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <Scroll
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scrollContent, hideFooter && { paddingBottom: 72 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Room Type Selector */}
        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Room Type</Text>
          <View style={styles.typeSelector}>
            {ROOM_TYPES.map((rt) => {
              const selected = roomType === rt.value;
              return (
                <TouchableOpacity
                  key={rt.value}
                  style={[
                    styles.typeCard,
                    {
                      backgroundColor: selected ? theme.colors.primary : theme.colors.backgroundSecondary,
                      borderColor: selected ? theme.colors.primary : theme.colors.border,
                    },
                  ]}
                  onPress={() => setRoomType(rt.value)}
                >
                  <MaterialCommunityIcons
                    name={rt.icon}
                    size={22}
                    color={selected ? '#FFFFFF' : theme.colors.textSecondary}
                  />
                  <Text style={[styles.typeCardLabel, { color: selected ? '#FFFFFF' : theme.colors.text }]}>
                    {rt.label}
                  </Text>
                  <Text style={[styles.typeCardDesc, { color: selected ? 'rgba(255,255,255,0.8)' : theme.colors.textSecondary }]}>
                    {rt.description}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* House Picker */}
        {houses && houses.length > 0 && (
          <View style={styles.inputSection}>
            <Text style={[styles.label, styles.sectionPadded, { color: theme.colors.text }]}>Create for</Text>
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={[null, ...houses]}
              keyExtractor={(item) => item?._id ?? 'personal'}
              contentContainerStyle={styles.chipList}
              renderItem={({ item }) => {
                const selected = item === null ? !selectedHouse : selectedHouse?._id === item._id;
                return (
                  <TouchableOpacity
                    style={[
                      styles.chip,
                      {
                        backgroundColor: selected ? theme.colors.primary : theme.colors.backgroundSecondary,
                      },
                    ]}
                    onPress={() => setSelectedHouse(item)}
                  >
                    {item && (
                      <MaterialCommunityIcons
                        name="home-group"
                        size={14}
                        color={selected ? '#FFFFFF' : theme.colors.textSecondary}
                        style={{ marginRight: 4 }}
                      />
                    )}
                    <Text style={[styles.chipText, { color: selected ? '#FFFFFF' : theme.colors.text }]}>
                      {item ? item.name : 'Personal'}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        )}

        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Title *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
            placeholder="What's your room about?"
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

        {/* Hide speaker permission for broadcast (backend forces invited) */}
        {!isBroadcast && (
          <View style={[styles.inputSection, styles.sectionPadded]}>
            <Text style={[styles.label, { color: theme.colors.text }]}>Who can speak?</Text>
            <View style={styles.radioGroup}>
              {([
                { value: 'everyone' as const, label: 'Everyone', icon: 'earth' as const },
                { value: 'followers' as const, label: 'People you follow', icon: 'account-group' as const },
                { value: 'invited' as const, label: 'Only invited speakers', icon: 'account-plus' as const },
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
        )}

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

CreateRoomSheet.displayName = 'CreateRoomSheet';

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
  typeSelector: {
    flexDirection: 'row',
    gap: 10,
  },
  typeCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  typeCardLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  typeCardDesc: {
    fontSize: 10,
    textAlign: 'center',
  },
  chipList: { gap: 8, paddingHorizontal: 16 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
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

export default CreateRoomSheet;
