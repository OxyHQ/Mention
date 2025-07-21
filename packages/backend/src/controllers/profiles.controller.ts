import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Profile, { IProfile } from "../models/Profile";
import { AuthRequest } from '../types/auth';
import createError from 'http-errors';
import { logger } from '../utils/logger';

export class ProfileController {
  
  /**
   * Get or create a profile for the authenticated user
   * This handles the auto-creation logic when a profile doesn't exist
   */
  async getOrCreateUserProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }

      // Check if MongoDB is connected
      if (mongoose.connection.readyState !== 1) {
        // Return mock data when DB is not available
        const mockProfile = {
          id: `profile_${userId}`,
          oxyUserId: userId,
          username: `user_${userId.slice(-8)}`,
          displayName: 'Demo User',
          bio: 'This is a demo profile (MongoDB not connected)',
          avatar: '',
          location: '',
          website: '',
          verified: false,
          isPersonal: true,
          profileType: 'personal',
          followers: 0,
          following: 0,
          postsCount: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        return res.status(200).json({
          success: true,
          message: 'Demo profile (MongoDB not connected)',
          data: mockProfile
        });
      }

      // Try to find existing profile first
      let profile = await Profile.findOne({ oxyUserId: userId });

      if (profile) {
        // Profile exists, return it
        return res.status(200).json({
          success: true,
          data: profile
        });
      }

      // Profile doesn't exist, create a new Personal profile
      // Extract user info from the authenticated request
      const userInfo = req.user || {};
      
      // Create default profile data with safe access to potentially undefined properties
      const defaultUsername = (userInfo as any).username || `user_${userId.slice(-8)}`;
      const userName = (userInfo as any).name;
      const defaultDisplayName = userName ? 
        (typeof userName === 'object' ? 
          `${userName.first || ''} ${userName.last || ''}`.trim() : 
          userName) :
        defaultUsername;

      const profileData = {
        oxyUserId: userId,
        username: defaultUsername,
        displayName: defaultDisplayName || defaultUsername,
        bio: '',
        avatar: (userInfo as any).avatar || '',
        location: (userInfo as any).location || '',
        website: (userInfo as any).website || '',
        verified: (userInfo as any).verified || false,
        isPersonal: true,
        profileType: 'personal' as const,
        followers: 0,
        following: 0,
        postsCount: 0
      };

      // Create the new profile
      profile = new Profile(profileData);
      await profile.save();

      logger.info(`Auto-created personal profile for user ${userId}: ${profile._id}`);

      return res.status(201).json({
        success: true,
        message: 'Personal profile created successfully',
        data: profile
      });

    } catch (error: any) {
      logger.error('Error in getOrCreateUserProfile:', error);
      
      // Handle unique constraint violation (username already exists)
      if (error.code === 11000) {
        return next(createError(409, 'Username already exists'));
      }
      
      return next(createError(500, 'Error retrieving or creating profile'));
    }
  }

  /**
   * Get a specific profile by oxyUserId
   */
  async getProfileByOxyUserId(req: Request, res: Response, next: NextFunction) {
    try {
      const { oxyUserId } = req.params;
      
      if (!oxyUserId) {
        return next(createError(400, 'Oxy User ID is required'));
      }

      // Check if MongoDB is connected
      if (mongoose.connection.readyState !== 1) {
        // Return mock data when DB is not available
        return res.status(404).json({
          success: false,
          message: 'Profile not found (MongoDB not connected)',
          error: 'Database unavailable'
        });
      }

      const profile = await Profile.findOne({ oxyUserId });

      if (!profile) {
        return next(createError(404, 'Profile not found'));
      }

      return res.status(200).json({
        success: true,
        data: profile
      });

    } catch (error) {
      logger.error('Error in getProfileByOxyUserId:', error);
      return next(createError(500, 'Error retrieving profile'));
    }
  }

  /**
   * Update the authenticated user's profile
   */
  async updateUserProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }

      const updateData = req.body;
      
      // Remove fields that shouldn't be updated directly
      delete updateData.oxyUserId;
      delete updateData.followers;
      delete updateData.following; 
      delete updateData.postsCount;
      delete updateData.created_at;
      delete updateData.updated_at;

      // Validate update data
      if (updateData.bio && updateData.bio.length > 500) {
        return next(createError(400, 'Bio cannot exceed 500 characters'));
      }

      if (updateData.location && updateData.location.length > 100) {
        return next(createError(400, 'Location cannot exceed 100 characters'));
      }

      // Find and update the profile
      const profile = await Profile.findOneAndUpdate(
        { oxyUserId: userId },
        { $set: updateData },
        { new: true, runValidators: true }
      );

      if (!profile) {
        return next(createError(404, 'Profile not found'));
      }

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: profile
      });

    } catch (error: any) {
      logger.error('Error in updateUserProfile:', error);
      
      // Handle unique constraint violation (username already exists)
      if (error.code === 11000) {
        return next(createError(409, 'Username already exists'));
      }

      // Handle validation errors
      if (error.name === 'ValidationError') {
        return next(createError(400, error.message));
      }
      
      return next(createError(500, 'Error updating profile'));
    }
  }

  /**
   * Create a new profile (for authenticated user)
   * This is called when user explicitly wants to create a profile
   */
  async createProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }

      // Check if profile already exists
      const existingProfile = await Profile.findOne({ oxyUserId: userId });
      if (existingProfile) {
        return next(createError(409, 'Profile already exists'));
      }

      const profileData = req.body;
      profileData.oxyUserId = userId;

      // Set defaults if this is marked as a personal profile
      if (profileData.isPersonalProfile || profileData.isPersonal) {
        profileData.isPersonal = true;
        profileData.profileType = 'personal';
      }

      // Create the new profile
      const profile = new Profile(profileData);
      await profile.save();

      logger.info(`Created new profile for user ${userId}: ${profile._id}`);

      return res.status(201).json({
        success: true,
        message: 'Profile created successfully',
        data: profile
      });

    } catch (error: any) {
      logger.error('Error in createProfile:', error);
      
      // Handle unique constraint violation
      if (error.code === 11000) {
        return next(createError(409, 'Username already exists'));
      }

      // Handle validation errors
      if (error.name === 'ValidationError') {
        return next(createError(400, error.message));
      }
      
      return next(createError(500, 'Error creating profile'));
    }
  }

  /**
   * Delete the authenticated user's profile
   */
  async deleteUserProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }

      const profile = await Profile.findOneAndDelete({ oxyUserId: userId });

      if (!profile) {
        return next(createError(404, 'Profile not found'));
      }

      logger.info(`Deleted profile for user ${userId}: ${profile._id}`);

      return res.status(200).json({
        success: true,
        message: 'Profile deleted successfully'
      });

    } catch (error) {
      logger.error('Error in deleteUserProfile:', error);
      return next(createError(500, 'Error deleting profile'));
    }
  }

  /**
   * Search profiles by username or display name
   */
  async searchProfiles(req: Request, res: Response, next: NextFunction) {
    try {
      const { q, limit = 20, page = 1 } = req.query;
      
      if (!q || typeof q !== 'string') {
        return next(createError(400, 'Search query is required'));
      }

      // Check if MongoDB is connected
      if (mongoose.connection.readyState !== 1) {
        // Return empty results when DB is not available
        return res.status(200).json({
          success: true,
          message: 'Search unavailable (MongoDB not connected)',
          data: {
            profiles: [],
            pagination: {
              page: 1,
              limit: 20,
              total: 0,
              pages: 0
            }
          }
        });
      }

      const searchLimit = Math.min(parseInt(limit as string) || 20, 50);
      const searchPage = Math.max(parseInt(page as string) || 1, 1);
      const skip = (searchPage - 1) * searchLimit;

      // Search by username or display name (case insensitive)
      const searchRegex = new RegExp(q, 'i');
      const profiles = await Profile.find({
        $or: [
          { username: searchRegex },
          { displayName: searchRegex }
        ]
      })
      .select('-__v') // Exclude version key
      .sort({ followers: -1, created_at: -1 }) // Sort by followers first, then by creation date
      .skip(skip)
      .limit(searchLimit);

      const total = await Profile.countDocuments({
        $or: [
          { username: searchRegex },
          { displayName: searchRegex }
        ]
      });

      return res.status(200).json({
        success: true,
        data: {
          profiles,
          pagination: {
            page: searchPage,
            limit: searchLimit,
            total,
            pages: Math.ceil(total / searchLimit)
          }
        }
      });

    } catch (error) {
      logger.error('Error in searchProfiles:', error);
      return next(createError(500, 'Error searching profiles'));
    }
  }
}