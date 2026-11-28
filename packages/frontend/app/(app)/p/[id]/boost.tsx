// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Redirect, useLocalSearchParams } from 'expo-router';

/** The old URL of the reposts screen (`/p/:id/boost`): links already out there keep working. */
export default function PostBoostRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/p/${id}/reposts` as never} />;
}
