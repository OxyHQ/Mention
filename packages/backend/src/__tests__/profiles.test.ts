import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ProfileController } from '../controllers/profiles.controller';
import Profile from '../models/Profile';
import { AuthRequest } from '../types/auth';

// Test setup
let mongoServer: MongoMemoryServer;
const profileController = new ProfileController();

// Mock Express Request/Response/NextFunction
const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext = jest.fn();

describe('Profile Controller', () => {
  beforeAll(async () => {
    // Start in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear all profiles before each test
    await Profile.deleteMany({});
    jest.clearAllMocks();
  });

  describe('getOrCreateUserProfile', () => {
    it('should create a new personal profile when none exists', async () => {
      const mockRequest: Partial<AuthRequest> = {
        userId: 'test-oxy-user-123',
        user: {
          id: 'test-oxy-user-123',
          username: 'testuser',
          name: { first: 'Test', last: 'User' },
          avatar: 'https://example.com/avatar.jpg',
          verified: false
        }
      };

      const res = mockResponse();
      const next = mockNext;

      await profileController.getOrCreateUserProfile(
        mockRequest as AuthRequest,
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Personal profile created successfully',
        data: expect.objectContaining({
          oxyUserId: 'test-oxy-user-123',
          username: 'testuser',
          displayName: 'Test User',
          isPersonal: true,
          profileType: 'personal',
          followers: 0,
          following: 0,
          postsCount: 0
        })
      });

      // Verify profile was saved to database
      const savedProfile = await Profile.findOne({ oxyUserId: 'test-oxy-user-123' });
      expect(savedProfile).toBeTruthy();
      expect(savedProfile?.username).toBe('testuser');
    });

    it('should return existing profile when one exists', async () => {
      // Create existing profile
      const existingProfile = new Profile({
        oxyUserId: 'test-oxy-user-456',
        username: 'existinguser',
        displayName: 'Existing User',
        bio: 'I already exist!',
        isPersonal: true,
        profileType: 'personal'
      });
      await existingProfile.save();

      const mockRequest: Partial<AuthRequest> = {
        userId: 'test-oxy-user-456',
        user: {
          id: 'test-oxy-user-456'
        }
      };

      const res = mockResponse();
      const next = mockNext;

      await profileController.getOrCreateUserProfile(
        mockRequest as AuthRequest,
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          oxyUserId: 'test-oxy-user-456',
          username: 'existinguser',
          bio: 'I already exist!'
        })
      });
    });

    it('should handle missing authentication', async () => {
      const mockRequest: Partial<AuthRequest> = {};
      const res = mockResponse();
      const next = mockNext;

      await profileController.getOrCreateUserProfile(
        mockRequest as AuthRequest,
        res,
        next
      );

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 401,
          message: 'Authentication required'
        })
      );
    });
  });

  describe('updateUserProfile', () => {
    it('should update profile successfully', async () => {
      // Create profile first
      const profile = new Profile({
        oxyUserId: 'test-oxy-user-789',
        username: 'updateuser',
        displayName: 'Update User',
        bio: 'Original bio',
        isPersonal: true,
        profileType: 'personal'
      });
      await profile.save();

      const mockRequest: Partial<AuthRequest> = {
        userId: 'test-oxy-user-789',
        body: {
          bio: 'Updated bio',
          location: 'New York'
        }
      };

      const res = mockResponse();
      const next = mockNext;

      await profileController.updateUserProfile(
        mockRequest as AuthRequest,
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Profile updated successfully',
        data: expect.objectContaining({
          bio: 'Updated bio',
          location: 'New York'
        })
      });
    });
  });
});

export { mongoServer };