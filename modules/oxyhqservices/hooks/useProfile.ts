import { useState, useCallback } from 'react';
import { profileService } from '@/modules/oxyhqservices';
import { OxyProfile } from '../types';

export const useProfile = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getProfile = useCallback(async (username: string) => {
    try {
      setLoading(true);
      setError(null);
      return await profileService.getProfileByUsername(username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch profile');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateProfile = useCallback(async (data: Partial<OxyProfile>) => {
    try {
      setLoading(true);
      setError(null);
      return await profileService.updateProfile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getFollowers = useCallback(async (userId: string) => {
    try {
      setLoading(true);
      setError(null);
      return await profileService.getFollowers(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch followers');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const getFollowing = useCallback(async (userId: string) => {
    try {
      setLoading(true);
      setError(null);
      return await profileService.getFollowing(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch following');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const followUser = useCallback(async (userId: string) => {
    try {
      setLoading(true);
      setError(null);
      await profileService.follow(userId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to follow user');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const unfollowUser = useCallback(async (userId: string) => {
    try {
      setLoading(true);
      setError(null);
      await profileService.unfollow(userId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unfollow user');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const getFollowingStatus = useCallback(async (userId: string) => {
    try {
      setLoading(true);
      setError(null);
      return await profileService.getFollowingStatus(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get following status');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    getProfile,
    updateProfile,
    getFollowers,
    getFollowing,
    followUser,
    unfollowUser,
    getFollowingStatus
  };
};