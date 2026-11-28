// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** A post's public permalink — what sharing a post, copying its link or sending it in Allo hands out. */
export const postPermalink = (postId: string): string => `https://mention.earth/p/${postId}`;
