import { Request, Response } from 'express';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { AuthRequest } from '../types/auth';
import mongoose from 'mongoose';
import { oxy as oxyClient } from '../../server';

// Create a new post
export const createPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    console.log('📝 Creating post with body:', JSON.stringify(req.body, null, 2));

    const { content, hashtags, mentions, quoted_post_id, repost_of, in_reply_to_status_id, contentLocation, postLocation } = req.body;

    // Support both new content structure and legacy text/media structure
    const text = content?.text || req.body.text;
    const media = content?.media || content?.images || req.body.media; // Support both new media field and legacy images
    const video = content?.video;
    const poll = content?.poll;
    const contentLocationData = content?.location || contentLocation;

    console.log('📍 Content location data:', contentLocationData);
    console.log('📍 Post location data:', postLocation);

    // Extract hashtags from text if not provided
    const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
    const uniqueTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

    const normalizeMedia = (arr: any[]): any[] => {
      if (!Array.isArray(arr)) return [];
      return arr.map((m: any) => {
        if (typeof m === 'string') return { id: m, type: 'image' };
        if (m && typeof m === 'object') return { id: m.id || m.fileId || m._id, type: m.type || 'image', mime: m.mime || m.contentType };
        return null;
      }).filter(Boolean);
    };

    // Process content location data (user's shared location)
    let processedContentLocation = null;
    if (contentLocationData) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (contentLocationData.type === 'Point' && Array.isArray(contentLocationData.coordinates) && contentLocationData.coordinates.length === 2) {
        longitude = contentLocationData.coordinates[0];
        latitude = contentLocationData.coordinates[1];
        address = contentLocationData.address;
        console.log('📍 Received GeoJSON format content location');
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof contentLocationData.latitude === 'number' && typeof contentLocationData.longitude === 'number') {
        longitude = contentLocationData.longitude;
        latitude = contentLocationData.latitude;
        address = contentLocationData.address;
        console.log('📍 Received legacy format content location');
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedContentLocation = {
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON format: [lng, lat]
          address: address || undefined
        };
        console.log('✅ Processed content location:', processedContentLocation);
      } else {
        console.log('❌ Invalid content location coordinates:', { longitude, latitude });
        return res.status(400).json({ 
          error: 'Invalid location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    // Process post location data (creation location metadata)
    let processedPostLocation = null;
    if (postLocation) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (postLocation.type === 'Point' && Array.isArray(postLocation.coordinates) && postLocation.coordinates.length === 2) {
        longitude = postLocation.coordinates[0];
        latitude = postLocation.coordinates[1];
        address = postLocation.address;
        console.log('📍 Received GeoJSON format post location');
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof postLocation.latitude === 'number' && typeof postLocation.longitude === 'number') {
        longitude = postLocation.longitude;
        latitude = postLocation.latitude;
        address = postLocation.address;
        console.log('📍 Received legacy format post location');
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedPostLocation = {
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON format: [lng, lat]
          address: address || undefined
        };
        console.log('✅ Processed post location:', processedPostLocation);
      } else {
        console.log('❌ Invalid post location coordinates:', { longitude, latitude });
        return res.status(400).json({ 
          error: 'Invalid post location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    // Build complete content object
    const postContent: any = {
      text: text || '',
      media: normalizeMedia(media || [])
    };

    // Add video to media array if provided
    if (video) {
      if (!postContent.media) postContent.media = [];
      postContent.media.push({ id: video, type: 'video' });
    }

    // Create poll separately if provided and add pollId to content
    let pollId = null;
    if (poll) {
      console.log('📊 Creating poll:', JSON.stringify(poll, null, 2));
      
      try {
        const pollDoc = new Poll({
          question: poll.question,
          options: poll.options.map((option: string) => ({ text: option, votes: [] })),
          postId: 'temp_' + Date.now(), // Temporary ID, will be updated after post creation
          createdBy: userId,
          endsAt: new Date(poll.endTime || Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
          isMultipleChoice: poll.isMultipleChoice || false,
          isAnonymous: poll.isAnonymous || false
        });
        
        const savedPoll = await pollDoc.save();
        pollId = savedPoll._id.toString();
        postContent.pollId = pollId;
        
        console.log('📊 Poll created with ID:', pollId);
      } catch (pollError) {
        console.error('Failed to create poll:', pollError);
        return res.status(400).json({ message: 'Failed to create poll', error: pollError });
      }
    }

    // Add location if provided
    if (processedContentLocation) {
      postContent.location = processedContentLocation;
    }

    console.log('📦 Final post content:', JSON.stringify(postContent, null, 2));

    const post = new Post({
      oxyUserId: userId,
      content: postContent,
      location: processedPostLocation,
      hashtags: uniqueTags,
      mentions: mentions || [],
      quoteOf: quoted_post_id || null,
      repostOf: repost_of || null,
      parentPostId: in_reply_to_status_id || null
    });

    console.log('💾 Saving post to database...');
    await post.save();
    console.log('✅ Post saved successfully');
    
    // Update poll's postId with the actual post ID
    if (pollId) {
      try {
        await Poll.findByIdAndUpdate(pollId, { postId: post._id.toString() });
        console.log('📊 Poll updated with post ID:', post._id.toString());
      } catch (pollUpdateError) {
        console.error('Failed to update poll postId:', pollUpdateError);
        // Continue execution - post was created successfully
      }
    }
    
    // No populate needed since oxyUserId is just a string reference

    // Transform the response to match frontend expectations
    const transformedPost = post.toObject() as any;
    const userData = transformedPost.oxyUserId;
    
    transformedPost.user = {
        id: typeof userData === 'object' ? userData._id : userData,
        name: typeof userData === 'object' ? userData.name.full : 'Unknown User',
        handle: typeof userData === 'object' ? userData.username : 'unknown',
        avatar: typeof userData === 'object' ? userData.avatar : '',
        verified: typeof userData === 'object' ? userData.verified : false
    };
    delete transformedPost.oxyUserId;

    res.status(201).json(transformedPost);
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ message: 'Error creating post', error });
  }
};

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const currentUserId = req.user?.id;

    const posts = await Post.find({ visibility: 'public' })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Get saved status for current user if authenticated
    let savedPostIds: string[] = [];
    let likedPostIds: string[] = [];
    if (currentUserId) {
      const savedPosts = await Bookmark.find({ userId: currentUserId }).lean();
      savedPostIds = savedPosts.map(saved => saved.postId.toString());

      const likedPosts = await Like.find({ userId: currentUserId }).lean();
      likedPostIds = likedPosts.map(liked => liked.postId.toString());
    }

    // Transform posts to match frontend expectations
    const transformedPosts = posts.map((post: any) => {
      const userData = post.oxyUserId;
      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isSaved: savedPostIds.includes(post._id.toString()),
        isLiked: likedPostIds.includes(post._id.toString()),
        oxyUserId: undefined
      };
    });

    res.json({
      posts: transformedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Error fetching posts', error });
  }
};

// Get post by ID
export const getPostById = async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const post = await Post.findById(req.params.id)
      .lean();

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if current user has saved this post
    let isSaved = false;
    if (currentUserId) {
      const savedPost = await Bookmark.findOne({ userId: currentUserId, postId: post._id.toString() });
      isSaved = !!savedPost;
    }

    // Transform post to match frontend expectations
    const oxyUserId = post.oxyUserId as any;

    // Build user object; fetch from Oxy when we only have an ID string
    let user = {
      id: typeof oxyUserId === 'object' ? oxyUserId._id : (oxyUserId || 'unknown'),
      name: typeof oxyUserId === 'object' ? oxyUserId.name.full : 'User',
      handle: typeof oxyUserId === 'object' ? oxyUserId.username : 'user',
      avatar: typeof oxyUserId === 'object' ? oxyUserId.avatar : '',
      verified: typeof oxyUserId === 'object' ? !!oxyUserId.verified : false,
    } as any;

    if (oxyUserId && typeof oxyUserId === 'string') {
      try {
        const fetched = await oxyClient.getUserById(oxyUserId);
        user = {
          id: fetched.id,
          name: fetched.name?.full || fetched.username || 'User',
          handle: fetched.username || 'user',
          avatar: typeof fetched.avatar === 'string' ? fetched.avatar : (fetched.avatar as any)?.url || '',
          verified: !!fetched.verified,
        };
      } catch (e) {
        // keep fallback user
        console.error('Failed fetching user from Oxy for post', req.params.id, e);
      }
    }

    const transformedPost = {
      ...post,
      user,
      isSaved,
      oxyUserId: undefined,
    } as any;

    res.json(transformedPost);
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ message: 'Error fetching post', error });
  }
};

// Update post
export const updatePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const post = await Post.findOne({ _id: req.params.id, oxyUserId: userId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const { text, media, hashtags, mentions, contentLocation, postLocation } = req.body;
    
    if (text !== undefined) {
      post.content.text = text;
      // Re-extract hashtags when text changes
      const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const uniqueTags = Array.from(new Set([...(hashtags || post.hashtags || []), ...extractedTags]));
      post.hashtags = uniqueTags;
    }
    if (media !== undefined) {
      const normalizeMedia = (arr: any[]): any[] => {
        if (!Array.isArray(arr)) return [];
        return arr.map((m: any) => {
          if (typeof m === 'string') return { id: m, type: 'image' };
          if (m && typeof m === 'object') return { id: m.id || m.fileId || m._id, type: m.type || 'image', mime: m.mime || m.contentType };
          return null;
        }).filter(Boolean);
      };
      post.content.media = normalizeMedia(media);
    }
    
    // Handle content location updates (user's shared location)
    if (contentLocation !== undefined) {
      if (contentLocation === null) {
        // Remove content location
        post.content.location = undefined;
      } else if (contentLocation.latitude !== undefined && contentLocation.longitude !== undefined) {
        // Update content location
        post.content.location = {
          type: 'Point',
          coordinates: [contentLocation.longitude, contentLocation.latitude], // GeoJSON format: [lng, lat]
          address: contentLocation.address || undefined
        };
      }
    }

    // Handle post location updates (creation location metadata)
    if (postLocation !== undefined) {
      if (postLocation === null) {
        // Remove post location
        post.location = undefined;
      } else if (postLocation.latitude !== undefined && postLocation.longitude !== undefined) {
        // Update post location
        post.location = {
          type: 'Point',
          coordinates: [postLocation.longitude, postLocation.latitude], // GeoJSON format: [lng, lat]
          address: postLocation.address || undefined
        };
      }
    }
    
    if (hashtags !== undefined) post.hashtags = hashtags || [];
    if (mentions !== undefined) post.mentions = mentions || [];

    await post.save();

    // Transform the response to match frontend expectations
    const transformedPost = post.toObject() as any;
    
    // For now, use placeholder user data since we don't have a User model
    transformedPost.user = {
        id: transformedPost.oxyUserId,
        name: 'User', // This should come from Oxy service in the future
        handle: transformedPost.oxyUserId, // Use oxyUserId as handle for now
        avatar: '', // Default avatar
        verified: false // Default to false
    };
    delete transformedPost.oxyUserId;

    res.json(transformedPost);
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ message: 'Error updating post', error });
  }
};

// Delete post
export const deletePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const post = await Post.findOneAndDelete({ _id: req.params.id, oxyUserId: userId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ message: 'Error deleting post', error });
  }
};

// Like post
export const likePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    // Check if already liked
    const existingLike = await Like.findOne({ userId, postId });
    if (existingLike) {
      return res.json({ message: 'Post already liked' });
    }

    // Create like record
    await Like.create({ userId, postId });

    // Update post stats
    await Post.findByIdAndUpdate(postId, {
      $inc: { 'stats.likesCount': 1 }
    });

    res.json({ message: 'Post liked successfully' });
  } catch (error) {
    console.error('Error liking post:', error);
    res.status(500).json({ message: 'Error liking post', error });
  }
};

// Unlike post
export const unlikePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    // Remove like record
    const result = await Like.deleteOne({ userId, postId });
    if (result.deletedCount === 0) {
      return res.json({ message: 'Post not liked' });
    }

    // Update post stats
    await Post.findByIdAndUpdate(postId, {
      $inc: { 'stats.likesCount': -1 }
    });

    res.json({ message: 'Post unliked successfully' });
  } catch (error) {
    console.error('Error unliking post:', error);
    res.status(500).json({ message: 'Error unliking post', error });
  }
};

// Save post
export const savePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    // Check if already saved
    const existingSave = await Bookmark.findOne({ userId, postId });
    if (existingSave) {
      return res.json({ message: 'Post already saved' });
    }

    // Create save record
    await Bookmark.create({ userId, postId });

    res.json({ message: 'Post saved successfully' });
  } catch (error) {
    console.error('Error saving post:', error);
    res.status(500).json({ message: 'Error saving post', error });
  }
 };

// Unsave post
export const unsavePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    // Remove save record
    const result = await Bookmark.deleteOne({ userId, postId });
    if (result.deletedCount === 0) {
      return res.json({ message: 'Post not saved' });
    }

    res.json({ message: 'Post unsaved successfully' });
  } catch (error) {
    console.error('Error unsaving post:', error);
    res.status(500).json({ message: 'Error unsaving post', error });
  }
};

// Repost
export const repostPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const originalPost = await Post.findById(req.params.id);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const repost = new Post({
      text: req.body.comment || '',
      userID: new mongoose.Types.ObjectId(userId),
      repost_of: new mongoose.Types.ObjectId(req.params.id)
    });

    await repost.save();
    await repost.populate('userID', 'username name avatar verified');

    res.status(201).json(repost);
  } catch (error) {
    console.error('Error creating repost:', error);
    res.status(500).json({ message: 'Error creating repost', error });
  }
};

// Quote post
export const quotePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const originalPost = await Post.findById(req.params.id);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const quotePost = new Post({
      text: req.body.text,
      userID: new mongoose.Types.ObjectId(userId),
      quoted_post_id: new mongoose.Types.ObjectId(req.params.id)
    });

    await quotePost.save();
    await quotePost.populate('userID', 'username name avatar verified');

    res.status(201).json(quotePost);
  } catch (error) {
    console.error('Error creating quote post:', error);
    res.status(500).json({ message: 'Error creating quote post', error });
  }
};

// Get saved posts for current user
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    // Get saved post IDs for the user
    const savedPosts = await Bookmark.find({ userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const postIds = savedPosts.map(saved => saved.postId);

    // Get the actual posts
    const posts = await Post.find({ 
      _id: { $in: postIds },
      visibility: 'public' 
    })
      .sort({ createdAt: -1 })
      .lean();

    // Fetch profile data for unique oxyUserIds (same as feed controller)
    const uniqueUserIds = Array.from(new Set(posts.map((p: any) => p.oxyUserId).filter(Boolean)));
    const userDataMap = new Map<string, any>();
    await Promise.all(uniqueUserIds.map(async (uid) => {
      try {
        const userData = await oxyClient.getUserById(uid);
        userDataMap.set(uid, {
          id: userData.id,
          name: userData.name?.full || userData.username || 'User',
          handle: userData.username || 'user',
          avatar: typeof userData.avatar === 'string' ? userData.avatar : (userData.avatar as any)?.url || '',
          verified: userData.verified || false
        });
      } catch (e) {
        // Fallback if lookup fails
        userDataMap.set(uid, {
          id: uid,
          name: 'User',
          handle: 'user',
          avatar: '',
          verified: false
        });
      }
    }));

    // Transform posts to match frontend expectations with real user profile
    const transformedPosts = posts.map((post: any) => {
      const userProfile = userDataMap.get(post.oxyUserId) || {
        id: post.oxyUserId,
        name: 'User',
        handle: 'user',
        avatar: '',
        verified: false
      };

      return {
        ...post,
        user: userProfile,
        isSaved: true, // All posts in this endpoint are saved
        oxyUserId: undefined
      };
    });

    res.json({
      posts: transformedPosts,
      hasMore: savedPosts.length === limit,
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching saved posts:', error);
    res.status(500).json({ message: 'Error fetching saved posts', error });
  }
};

// Get posts by hashtag
export const getPostsByHashtag = async (req: Request, res: Response) => {
  try {
    const hashtag = req.params.hashtag;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const posts = await Post.find({
      hashtags: { $in: [hashtag] },
      status: 'published'
    })
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json({
      posts,
      hashtag,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching posts by hashtag:', error);
    res.status(500).json({ message: 'Error fetching posts by hashtag', error });
  }
};

// Get drafts
export const getDrafts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const drafts = await Post.find({
      userID: userId,
      status: 'draft'
    })
      .sort({ created_at: -1 })
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json(drafts);
  } catch (error) {
    console.error('Error fetching drafts:', error);
    res.status(500).json({ message: 'Error fetching drafts', error });
  }
};

// Get scheduled posts
export const getScheduledPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const scheduledPosts = await Post.find({
      userID: userId,
      status: 'scheduled'
    })
      .sort({ scheduledFor: 1 })
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json(scheduledPosts);
  } catch (error) {
    console.error('Error fetching scheduled posts:', error);
    res.status(500).json({ message: 'Error fetching scheduled posts', error });
  }
}; 

// Get nearby posts based on location
export const getNearbyPosts = async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius = 10000, locationType = 'content' } = req.query; // radius in meters, default 10km
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const radiusMeters = parseInt(radius as string);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    // MongoDB geospatial query to find posts within radius
    const posts = await Post.find({
      visibility: 'public',
      [locationField]: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
          },
          $maxDistance: radiusMeters
        }
      }
    })
      .sort({ createdAt: -1 })
      .limit(50) // Limit to prevent too many results
      .lean();

    // Get current user for liked/saved status
    const currentUserId = req.user?.id;
    let savedPostIds: string[] = [];
    let likedPostIds: string[] = [];
    
    if (currentUserId) {
      const savedPosts = await Bookmark.find({ userId: currentUserId }).lean();
      savedPostIds = savedPosts.map(saved => saved.postId.toString());

      const likedPosts = await Like.find({ userId: currentUserId }).lean();
      likedPostIds = likedPosts.map(liked => liked.postId.toString());
    }

    // Transform posts to match frontend expectations
    const transformedPosts = posts.map((post: any) => {
      const userData = post.oxyUserId;
      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isLiked: likedPostIds.includes(post._id.toString()),
        isSaved: savedPostIds.includes(post._id.toString())
      };
    });

    // Remove oxyUserId from response
    transformedPosts.forEach(post => delete post.oxyUserId);

    res.json({
      posts: transformedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType,
      count: transformedPosts.length
    });
  } catch (error) {
    console.error('Error fetching nearby posts:', error);
    res.status(500).json({ message: 'Error fetching nearby posts', error });
  }
};

// Get posts within a bounding box area
export const getPostsInArea = async (req: AuthRequest, res: Response) => {
  try {
    const { north, south, east, west, locationType = 'content' } = req.query;
    
    if (!north || !south || !east || !west) {
      return res.status(400).json({ 
        message: 'Bounding box coordinates (north, south, east, west) are required' 
      });
    }

    const northLat = parseFloat(north as string);
    const southLat = parseFloat(south as string);
    const eastLng = parseFloat(east as string);
    const westLng = parseFloat(west as string);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (isNaN(northLat) || isNaN(southLat) || isNaN(eastLng) || isNaN(westLng)) {
      return res.status(400).json({ message: 'Invalid bounding box coordinates' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    // MongoDB geospatial query to find posts within bounding box
    const posts = await Post.find({
      visibility: 'public',
      [locationField]: {
        $geoWithin: {
          $box: [
            [westLng, southLat], // bottom-left corner [lng, lat]
            [eastLng, northLat]  // top-right corner [lng, lat]
          ]
        }
      }
    })
      .sort({ createdAt: -1 })
      .limit(100) // Limit to prevent too many results
      .lean();

    // Get current user for liked/saved status
    const currentUserId = req.user?.id;
    let savedPostIds: string[] = [];
    let likedPostIds: string[] = [];
    
    if (currentUserId) {
      const savedPosts = await Bookmark.find({ userId: currentUserId }).lean();
      savedPostIds = savedPosts.map(saved => saved.postId.toString());

      const likedPosts = await Like.find({ userId: currentUserId }).lean();
      likedPostIds = likedPosts.map(liked => liked.postId.toString());
    }

    // Transform posts to match frontend expectations
    const transformedPosts = posts.map((post: any) => {
      const userData = post.oxyUserId;
      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isLiked: likedPostIds.includes(post._id.toString()),
        isSaved: savedPostIds.includes(post._id.toString())
      };
    });

    // Remove oxyUserId from response
    transformedPosts.forEach(post => delete post.oxyUserId);

    res.json({
      posts: transformedPosts,
      boundingBox: { north: northLat, south: southLat, east: eastLng, west: westLng },
      locationType,
      count: transformedPosts.length
    });
  } catch (error) {
    console.error('Error fetching posts in area:', error);
    res.status(500).json({ message: 'Error fetching posts in area', error });
  }
};

// Get nearby posts based on both user and post locations
export const getNearbyPostsBothLocations = async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius = 10000 } = req.query; // radius in meters, default 10km
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const radiusMeters = parseInt(radius as string);

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    // MongoDB geospatial query to find posts within radius for either location type
    const posts = await Post.find({
      visibility: 'public',
      $or: [
        {
          'content.location': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
              },
              $maxDistance: radiusMeters
            }
          }
        },
        {
          'location': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
              },
              $maxDistance: radiusMeters
            }
          }
        }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(75) // Slightly higher limit since we're querying both location types
      .lean();

    // Get current user for liked/saved status
    const currentUserId = req.user?.id;
    let savedPostIds: string[] = [];
    let likedPostIds: string[] = [];
    
    if (currentUserId) {
      const savedPosts = await Bookmark.find({ userId: currentUserId }).lean();
      savedPostIds = savedPosts.map(saved => saved.postId.toString());

      const likedPosts = await Like.find({ userId: currentUserId }).lean();
      likedPostIds = likedPosts.map(liked => liked.postId.toString());
    }

    // Transform posts to match frontend expectations
    const transformedPosts = posts.map((post: any) => {
      const userData = post.oxyUserId;
      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isLiked: likedPostIds.includes(post._id.toString()),
        isSaved: savedPostIds.includes(post._id.toString())
      };
    });

    // Remove oxyUserId from response
    transformedPosts.forEach(post => delete post.oxyUserId);

    res.json({
      posts: transformedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType: 'both',
      count: transformedPosts.length
    });
  } catch (error) {
    console.error('Error fetching nearby posts (both locations):', error);
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)', error });
  }
};

// Get location statistics for analytics
export const getLocationStats = async (req: AuthRequest, res: Response) => {
  try {
    // Count posts with content locations (user shared)
    const contentLocationCount = await Post.countDocuments({
      visibility: 'public',
      'content.location': { $exists: true, $ne: null }
    });

    // Count posts with post locations (creation metadata)
    const postLocationCount = await Post.countDocuments({
      visibility: 'public',
      'location': { $exists: true, $ne: null }
    });

    // Count posts with both location types
    const bothLocationsCount = await Post.countDocuments({
      visibility: 'public',
      'content.location': { $exists: true, $ne: null },
      'location': { $exists: true, $ne: null }
    });

    // Get total post count for percentage calculation
    const totalPosts = await Post.countDocuments({ visibility: 'public' });

    res.json({
      total: totalPosts,
      withContentLocation: contentLocationCount,
      withPostLocation: postLocationCount,
      withBothLocations: bothLocationsCount,
      withAnyLocation: await Post.countDocuments({
        visibility: 'public',
        $or: [
          { 'content.location': { $exists: true, $ne: null } },
          { 'location': { $exists: true, $ne: null } }
        ]
      }),
      percentages: {
        contentLocation: totalPosts > 0 ? ((contentLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        postLocation: totalPosts > 0 ? ((postLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        bothLocations: totalPosts > 0 ? ((bothLocationsCount / totalPosts) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (error) {
    console.error('Error fetching location stats:', error);
    res.status(500).json({ message: 'Error fetching location stats', error });
  }
};
