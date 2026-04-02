import React from 'react';
import { SettingsListItem, SettingsListGroup, SettingsListDivider } from '@oxyhq/bloom/settings-list';
import type { SettingsListItemProps, SettingsListGroupProps } from '@oxyhq/bloom/settings-list';

// Re-export bloom's SettingsList components with Mention's existing API names
export const SettingsItem = SettingsListItem;
export const SettingsGroup = SettingsListGroup;
export const SettingsDivider = SettingsListDivider;

// Re-export types
export type { SettingsListItemProps as SettingsItemProps };
export type { SettingsListGroupProps as SettingsGroupProps };
