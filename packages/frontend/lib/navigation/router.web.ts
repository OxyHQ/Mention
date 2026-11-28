// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** App routing defaults to Expo; Bloom provides independent scopes inside panels. */
export type { Href } from 'expo-router';
export {
  Link,
  Redirect,
  Slot,
  useRouter,
  usePathname,
  useLocalSearchParams,
  useGlobalSearchParams,
  useIsFocused,
  useFocusEffect,
} from '@oxy.so/bloom/panel-routing/expo-router';
