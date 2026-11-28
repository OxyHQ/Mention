// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

declare module '@/assets/images/*' {
  // Metro turns a bundled image into an asset reference, which is exactly what
  // `ImageRequireSource` describes — a number on native, an object on web.
  import type { ImageRequireSource } from 'react-native';

  const value: ImageRequireSource;
  export default value;
}
