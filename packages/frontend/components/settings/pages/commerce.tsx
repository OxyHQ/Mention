// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useAuth } from '@oxy.so/services/ui/client';
import { StorefrontSettings } from '@/components/Commerce/StorefrontSettings';
export default function CommerceSettingsPage() {
  const { user, canUsePrivateApi } = useAuth();
  return user?.id && canUsePrivateApi ? <StorefrontSettings accountId={user.id} /> : null;
}
