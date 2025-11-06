/**
 * RealtimePostsBridge Component
 * Extracted from _layout.tsx for better organization
 * Keeps posts socket connected (mounted under OxyProvider)
 */

import React from 'react';
import useRealtimePosts from '@/hooks/useRealtimePosts';

/**
 * Bridge component that enables realtime posts functionality
 * Must be rendered under OxyProvider to access useOxy
 */
export function RealtimePostsBridge() {
  useRealtimePosts();
  return null;
}

