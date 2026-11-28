// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { usePathname } from '@/lib/navigation/router';
import { INSTANCE_NAME } from '@/config';
import { initialSEODocumentPath, releaseServerSEOForNavigation } from '@/lib/seoHandoff';

/** Routes without an SEO component must also retire the previous server page. */
export function SEOHandoff(): null {
  const pathname = usePathname();
  const [initialTitle] = useState(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    initialSEODocumentPath(document);
    return document.querySelector('title[data-mention-seo="true"]')?.textContent ?? undefined;
  });
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      releaseServerSEOForNavigation(document, pathname, initialTitle, INSTANCE_NAME);
    }
  }, [pathname, initialTitle]);
  return null;
}
