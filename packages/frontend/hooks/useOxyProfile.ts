import { useEffect } from 'react';
import { useOxy } from '@oxyhq/services/full';
import { useAppSelector, useAppDispatch } from './useRedux';
import { 
  fetchProfile, 
  setCurrentProfile, 
  clearCurrentProfile 
} from '@/store/reducers/profileReducer';

/**
 * Custom hook that integrates OxyHQ Services authentication with Redux profile management.
 * 
 * This hook automatically:
 * - Fetches the user's profile when they log in via Oxy
 * - Clears the profile when they log out
 * - Provides convenient access to both Oxy user and Redux profile data
 * 
 * @returns Object containing authentication state, profile data, and utility functions
 */
export const useOxyProfile = () => {
  const dispatch = useAppDispatch();
  const { user: oxyUser, isAuthenticated, login, logout, isLoading: oxyLoading } = useOxy();
  
  // Get profile state from Redux
  const currentProfile = useAppSelector(state => state.profile.currentProfile);
  const profileLoading = useAppSelector(state => state.profile.profileLoading);
  const profileError = useAppSelector(state => state.profile.error);
  
  // Auto-sync profile with Oxy authentication
  useEffect(() => {
    if (isAuthenticated && oxyUser && !currentProfile) {
      // User is authenticated but no profile loaded - fetch it
      dispatch(fetchProfile(oxyUser.id));
    } else if (!isAuthenticated && currentProfile) {
      // User logged out but profile still loaded - clear it
      dispatch(clearCurrentProfile());
    }
  }, [isAuthenticated, oxyUser, currentProfile, dispatch]);
  
  /**
   * Login with credentials and automatically fetch profile
   */
  const loginWithProfile = async (usernameOrEmail: string, password: string) => {
    try {
      await login(usernameOrEmail, password);
      // Profile will be fetched automatically via useEffect
    } catch (error) {
      throw error;
    }
  };
  
  /**
   * Logout and clear profile data
   */
  const logoutAndClearProfile = async () => {
    try {
      await logout();
      // Profile will be cleared automatically via useEffect
    } catch (error) {
      throw error;
    }
  };
  
  /**
   * Set profile data directly (useful for creating new profiles)
   */
  const setProfile = (profileData: any) => {
    if (oxyUser) {
      dispatch(setCurrentProfile({
        ...profileData,
        oxyUserId: oxyUser.id,
      }));
    }
  };
  
  /**
   * Force refresh the current profile
   */
  const refreshProfile = () => {
    if (oxyUser) {
      dispatch(fetchProfile(oxyUser.id));
    }
  };
  
  // Determine overall loading state
  const isLoading = oxyLoading || profileLoading;
  
  // Determine if user is fully ready (authenticated + profile loaded)
  const isReady = isAuthenticated && !!currentProfile && !isLoading;
  
  return {
    // Authentication state (from Oxy)
    oxyUser,
    isAuthenticated,
    oxyLoading,
    
    // Profile state (from Redux)
    profile: currentProfile,
    profileLoading,
    profileError,
    
    // Combined state
    isLoading,
    isReady,
    
    // Actions
    loginWithProfile,
    logoutAndClearProfile,
    setProfile,
    refreshProfile,
    
         // Direct access to original functions if needed
     login,
     logout,
   };
 };
 