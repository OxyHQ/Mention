// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';

// This route handles direct URLs like /search/cats
// It redirects to the main search page with the query pre-filled
export default function SearchWithQuery() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const query = (params.query as string) || '';

  useEffect(() => {
    // Navigate to main search page with query param
    router.replace({
      pathname: '/search',
      params: { q: query.trim() },
    });
  }, [query]);

  return null;
}
