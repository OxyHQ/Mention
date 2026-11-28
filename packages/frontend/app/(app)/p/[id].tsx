// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
import { useLocalSearchParams } from '@/lib/navigation/router';
import PostDetailScreen from '@/components/Post/PostDetailScreen';

export default function PostRoute() {
  const panel = useOptionalPanelRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PostDetailScreen postId={id ?? ''} onBack={panel?.back} />;
}
