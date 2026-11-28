// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Application-wide constants
 * Centralized configuration for better maintainability
 */

export const STORAGE_KEYS = {
  NOTIFICATION_EDUCATION_SHOWN: 'pref:notifications:educationShown',
  LANGUAGE_PREFERENCE: 'user_language_preference',
  THREAD_SORT: 'pref:thread:sortOrder',
  THREAD_TREE_VIEW: 'pref:thread:treeView',
  VOTE_STYLE: 'pref:post:voteStyle',
} as const;

export const DEFAULT_LANGUAGE = 'en-US';

export const SUPPORTED_LANGUAGES = [
  'en-US',
  'es-ES',
  'it-IT',
  'ca-ES',
  'fr-FR',
  'pt-BR',
  'de-DE',
  'ru-RU',
  'zh-CN',
  'hi-IN',
  'ar-SA',
  'bn-BD',
  'ja-JP',
  'id-ID',
  'tr-TR',
] as const;

export const INITIALIZATION_TIMEOUT = {
  AUTH: 1000, // Fast timeout for cached token check
} as const;
