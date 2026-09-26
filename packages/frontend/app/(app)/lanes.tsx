import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditBoxLine } from '@oxy.so/bloom/icons/RiEditBoxLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiGitMergeLine } from '@oxy.so/bloom/icons/RiGitMergeLine';
import { RiInformationFill } from '@oxy.so/bloom/icons/RiInformationFill';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxy.so/core/logger';
import type { Lane, LaneDisplayMode } from '@mention/shared-types';
import {
  LANE_DISPLAY_MODES,
  MAX_LANES_PER_OWNER,
  MAX_LANE_NAME_LENGTH,
} from '@mention/shared-types/lane';
import { LaneIcon } from '@/assets/icons/lane-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { confirmDialog } from '@/utils/alerts';
import { showActionMenu } from '@/components/common/ActionMenu';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { getErrorMessage } from '@/utils/apiError';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SEO } from '@/components/SEO';

const lanesLogger = createLogger('Lanes');

/** The glyph each showcase mode is recognised by, on this screen and nowhere else. */
const MODE_ICON: Record<LaneDisplayMode, BloomIcon> = {
    mixed: RiGitMergeLine,
    tab: RiNodeTree,
    hidden: RiEyeOffLine,
};

function ModeIcon({ mode, size, fill }: { mode: LaneDisplayMode; size: number; fill: string }) {
    const Glyph = MODE_ICON[mode];
    return <Glyph width={size} height={size} fill={fill} />;
}

/**
 * The author's own lanes: create, rename, decide where each one shows, delete.
 *
 * A lane is a LENS, not a destination — nothing here changes who receives a post
 * or where it federates. What it changes is the author's own showcase, which is
 * why `displayMode` is presented as three plain statements about the profile
 * rather than as an enum name.
 *
 * `hidden` says exactly what it does, including the part authors get wrong: the
 * posts stay in everybody's feeds and stay reachable by URL. It is curation, not
 * privacy, and the copy has to carry that or somebody will use it as one.
 */
export default function LanesScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { isAuthenticated, user, canUsePrivateApi } = useAuth();
    const queryClient = useQueryClient();
    const [input, setInput] = useState('');
    const [editingLaneId, setEditingLaneId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');

    const header = (
        <PageHeader
            title={t('lanes.title', { defaultValue: 'Lanes' })}
            onBack={() => safeBack()}
            backLabel={t('common.back', { defaultValue: 'Back' })}
        />
    );

    const lanesQueryKey = viewerQueryKeys.ownedLanes(user?.id);
    const {
        data: lanes = [],
        isLoading,
        isError,
        refetch,
    } = useQuery<Lane[]>({
        queryKey: lanesQueryKey,
        queryFn: () => lanesService.listMine(),
        enabled: canUsePrivateApi,
    });

    // Creating a lane changes no list's membership — a brand-new lane is empty —
    // so this one only refreshes the collection. Every OTHER write here goes
    // through `noteLaneListsChanged`, which reaches the feed store too.
    const refreshLanes = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: lanesQueryKey });
    }, [queryClient, lanesQueryKey]);

    const reportFailure = useCallback(
        (error: unknown, fallback: string) => {
            lanesLogger.error(fallback, error);
            toast(getErrorMessage(error, fallback), { type: 'error' });
        },
        [],
    );

    const createMutation = useMutation<Lane, unknown, string>({
        mutationFn: (name: string) => lanesService.create({ name }),
        onSuccess: () => {
            setInput('');
            refreshLanes();
            toast(t('lanes.created', { defaultValue: 'Lane created' }), { type: 'success' });
        },
        onError: (error) =>
            reportFailure(error, t('lanes.createFailed', { defaultValue: 'Failed to create lane' })),
    });

    const renameMutation = useMutation<Lane, unknown, { id: string; name: string }>({
        mutationFn: ({ id, name }) => lanesService.update(id, { name }),
        onSuccess: () => {
            setEditingLaneId(null);
            setEditingName('');
            refreshLanes();
        },
        onError: (error) =>
            reportFailure(error, t('lanes.renameFailed', { defaultValue: 'Failed to rename lane' })),
    });

    const displayModeMutation = useMutation<Lane, unknown, { id: string; displayMode: LaneDisplayMode }>({
        mutationFn: ({ id, displayMode }) => lanesService.update(id, { displayMode }),
        onSuccess: () => {
            // Which posts the profile's tabs CONTAIN just changed, on a surface
            // React Query does not own. The feed store has to hear about it or
            // the profile keeps serving its retained slice until a full reload.
            noteLaneListsChanged('assignment');
        },
        onError: (error) =>
            reportFailure(error, t('lanes.displayModeFailed', { defaultValue: 'Failed to update lane' })),
    });

    const deleteMutation = useMutation<void, unknown, string>({
        mutationFn: (id: string) => lanesService.remove(id),
        onSuccess: () => {
            // Deleting a lane takes its posts off it, so everything the lane was
            // keeping off the profile comes back.
            noteLaneListsChanged('assignment');
            toast(t('lanes.deleted', { defaultValue: 'Lane deleted' }), { type: 'success' });
        },
        onError: (error) =>
            reportFailure(error, t('lanes.deleteFailed', { defaultValue: 'Failed to delete lane' })),
    });

    const modeLabel = useCallback(
        (mode: LaneDisplayMode): string => {
            if (mode === 'tab') return t('lanes.mode.tab', { defaultValue: 'Its own tab only' });
            if (mode === 'hidden') return t('lanes.mode.hidden', { defaultValue: 'Off your profile' });
            return t('lanes.mode.mixed', { defaultValue: 'On your main tab' });
        },
        [t],
    );

    const modeDescription = useCallback(
        (mode: LaneDisplayMode): string => {
            if (mode === 'tab') {
                return t('lanes.mode.tabDesc', {
                    defaultValue: 'Off the main tab. Readers find these posts on the lane’s own tab.',
                });
            }
            if (mode === 'hidden') {
                return t('lanes.mode.hiddenDesc', {
                    defaultValue: 'Off your profile entirely, including for you. The posts still reach feeds and still open by link — this is curation, not privacy.',
                });
            }
            return t('lanes.mode.mixedDesc', {
                defaultValue: 'These posts sit on your main tab like any other.',
            });
        },
        [t],
    );

    const handleAdd = useCallback(() => {
        const value = input.trim();
        if (!value || createMutation.isPending) return;
        createMutation.mutate(value);
    }, [input, createMutation]);

    const handleSaveRename = useCallback(
        (lane: Lane) => {
            const value = editingName.trim();
            if (!value || value === lane.name) {
                setEditingLaneId(null);
                setEditingName('');
                return;
            }
            renameMutation.mutate({ id: lane.id, name: value });
        },
        [editingName, renameMutation],
    );

    const handleDelete = useCallback(
        async (lane: Lane) => {
            const confirmed = await confirmDialog({
                title: t('lanes.delete', { defaultValue: 'Delete lane' }),
                message: t('lanes.deleteConfirm', {
                    lane: lane.name,
                    defaultValue: 'Delete «{{lane}}»? Its posts stay exactly where they are — they simply stop being on a lane, and any of them you were keeping off your profile come back.',
                }),
                okText: t('lanes.delete', { defaultValue: 'Delete lane' }),
                cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
                destructive: true,
            });
            if (confirmed) deleteMutation.mutate(lane.id);
        },
        [deleteMutation, t],
    );

    const openLaneMenu = useCallback(
        (lane: Lane) => {
            const modeActions: ActionMenuAction[] = LANE_DISPLAY_MODES.map((mode) => ({
                icon: <ModeIcon mode={mode} size={22} fill={mode === lane.displayMode ? colors.primary : colors.textSecondary} />,
                label: modeLabel(mode),
                onPress: () => {
                    if (mode === lane.displayMode) return;
                    displayModeMutation.mutate({ id: lane.id, displayMode: mode });
                },
            }));

            showActionMenu({
                label: lane.name,
                groups: [
                    [
                        {
                            icon: <RiEditBoxLine width={22} height={22} fill={colors.textSecondary} />,
                            label: t('lanes.rename', { defaultValue: 'Rename' }),
                            onPress: () => {
                                setEditingLaneId(lane.id);
                                setEditingName(lane.name);
                            },
                        },
                    ],
                    modeActions,
                    [
                        {
                            icon: <RiDeleteBinLine width={22} height={22} fill={colors.error} />,
                            label: t('lanes.delete', { defaultValue: 'Delete lane' }),
                            onPress: () => handleDelete(lane),
                            color: colors.error,
                        },
                    ],
                ],
            });
        },
        [colors, displayModeMutation, handleDelete, modeLabel, t],
    );

    if (!isAuthenticated) {
        return (
            <View className="flex-1">
                {header}
                <OxyAuthPrompt
                    label={t('lanes.signInRequired', { defaultValue: 'Sign in to manage your lanes' })}
                    description={t('lanes.signInRequiredDesc', {
                        defaultValue: 'Lanes let you keep separate tracks of your posts and decide which ones reach your profile.',
                    })}
                />
            </View>
        );
    }

    const atCap = lanes.length >= MAX_LANES_PER_OWNER;

    return (
        <>
            <SEO
                title={t('lanes.title', { defaultValue: 'Lanes' })}
                description={t('lanes.description', {
                    defaultValue: 'Keep separate tracks of your posts and decide which ones reach your profile.',
                })}
            />
            <View className="flex-1">
                {header}

                <ScrollView
                    className="flex-1"
                    contentContainerClassName="py-2"
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                >
                    <SettingsListGroup>
                        <View className="px-4 py-3.5 flex-row items-center gap-3">
                            <RiInformationFill size="md" fill={colors.primary} />
                            <Text className="flex-1 text-[13px] text-foreground">
                                {t('lanes.description', {
                                    defaultValue: 'Keep separate tracks of your posts and decide which ones reach your profile.',
                                })}
                            </Text>
                        </View>
                    </SettingsListGroup>

                    <SettingsListGroup title={t('lanes.addLane', { defaultValue: 'New lane' })}>
                        <View className="px-4 py-3 flex-row items-center gap-3">
                            <LaneIcon size={20} color={colors.textSecondary} />
                            <TextInput
                                className="flex-1 text-[15px] text-foreground"
                                placeholder={t('lanes.namePlaceholder', { defaultValue: 'Lane name' })}
                                placeholderTextColor={colors.textSecondary}
                                value={input}
                                onChangeText={setInput}
                                maxLength={MAX_LANE_NAME_LENGTH}
                                autoCorrect={false}
                                returnKeyType="done"
                                onSubmitEditing={handleAdd}
                                editable={!createMutation.isPending && !atCap}
                            />
                            {createMutation.isPending ? (
                                <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                            ) : (
                                <TouchableOpacity
                                    accessibilityRole="button"
                                    accessibilityLabel={t('lanes.addLane', { defaultValue: 'New lane' })}
                                    disabled={input.trim().length === 0 || atCap}
                                    onPress={handleAdd}
                                    activeOpacity={0.7}
                                >
                                    <RiAddCircleLine width={26} height={26} fill={input.trim().length === 0 || atCap ? colors.textSecondary : colors.primary} />
                                </TouchableOpacity>
                            )}
                        </View>
                        {atCap ? (
                            <View className="px-4 pb-3">
                                <Text className="text-[13px] text-muted-foreground">
                                    {t('lanes.atCap', {
                                        count: MAX_LANES_PER_OWNER,
                                        defaultValue: 'You can have at most {{count}} lanes.',
                                    })}
                                </Text>
                            </View>
                        ) : null}
                    </SettingsListGroup>

                    <SettingsListGroup title={t('lanes.yourLanes', { defaultValue: 'Your lanes' })}>
                        {isLoading ? (
                            <View className="py-10 items-center">
                                <Loading className="text-primary" size="large" style={{ flex: undefined }} />
                            </View>
                        ) : isError ? (
                            <View className="py-4">
                                <EmptyState
                                    title={t('lanes.loadFailed', { defaultValue: 'Failed to load your lanes' })}
                                    icon={{ name: 'alert-circle-outline', size: 48 }}
                                    error={{
                                        title: t('lanes.loadFailed', { defaultValue: 'Failed to load your lanes' }),
                                        message: t('common.tryAgain', { defaultValue: 'Try again' }),
                                        onRetry: async () => {
                                            await refetch();
                                        },
                                    }}
                                />
                            </View>
                        ) : lanes.length === 0 ? (
                            <View className="py-4">
                                <EmptyState
                                    title={t('lanes.empty', { defaultValue: 'No lanes yet' })}
                                    icon={{ name: 'git-branch-outline', size: 48 }}
                                />
                            </View>
                        ) : (
                            lanes.map((lane) =>
                                lane.id === editingLaneId ? (
                                    <View key={lane.id} className="px-4 py-3 flex-row items-center gap-3">
                                        <RiEditBoxLine size="md" fill={colors.textSecondary} />
                                        <TextInput
                                            className="flex-1 text-[15px] text-foreground"
                                            value={editingName}
                                            onChangeText={setEditingName}
                                            maxLength={MAX_LANE_NAME_LENGTH}
                                            autoCorrect={false}
                                            autoFocus
                                            returnKeyType="done"
                                            onSubmitEditing={() => handleSaveRename(lane)}
                                            editable={!renameMutation.isPending}
                                        />
                                        <TouchableOpacity
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.save', { defaultValue: 'Save' })}
                                            onPress={() => handleSaveRename(lane)}
                                            activeOpacity={0.7}
                                        >
                                            <Text className="text-[13px] font-semibold text-primary">
                                                {t('common.save', { defaultValue: 'Save' })}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : (
                                    <SettingsListItem
                                        key={lane.id}
                                        icon={<ModeIcon mode={lane.displayMode} size={20} fill={colors.textSecondary} />}
                                        title={lane.name}
                                        description={`${t('lanes.postCount', {
                                            count: lane.postCount ?? 0,
                                            defaultValue: '{{count}} posts',
                                        })} · ${modeLabel(lane.displayMode)}`}
                                        onPress={() => openLaneMenu(lane)}
                                    />
                                ),
                            )
                        )}
                    </SettingsListGroup>

                    <View className="px-4 pt-2 pb-6 gap-1">
                        {LANE_DISPLAY_MODES.map((mode) => (
                            <Text key={mode} className="text-[12px] text-muted-foreground">
                                <Text className="font-semibold">{modeLabel(mode)}</Text>
                                {` — ${modeDescription(mode)}`}
                            </Text>
                        ))}
                    </View>
                </ScrollView>
            </View>
        </>
    );
}
