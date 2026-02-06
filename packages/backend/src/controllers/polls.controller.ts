import { Request, Response, NextFunction } from 'express';
import Poll, { IPoll } from '../models/Poll';
import Post from '../models/Post';
import { AuthRequest } from '../types/auth';
import { createError } from '../utils/error';
import mongoose from 'mongoose';

class PollsController {
  async createPoll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { question, options, postId, endsAt, isMultipleChoice, isAnonymous } = req.body;
      const userId = req.user?.id;

      // Debug logging for authentication
      console.log('Polls createPoll auth debug:', {
        hasUser: !!req.user,
        userKeys: req.user ? Object.keys(req.user) : [],
        userId: userId,
        userIdType: typeof userId
      });

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      // Validate required fields
      if (!question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Question and at least 2 options are required'
        });
      }

      // For temporary polls (created before the post), we don't validate the post ID
      let post = null;
      let finalPostId = postId;
      
      // Log the incoming postId for debugging
      console.log(`Creating poll with postId: ${postId}, type: ${typeof postId}, isTemp: ${postId?.toString().startsWith('temp_')}`);
      
      if (postId && !postId.toString().startsWith('temp_')) {
        try {
          // Check if post exists
          post = await Post.findById(postId);
          if (!post) {
            return res.status(404).json({
              error: 'Not found',
              message: 'Post not found'
            });
          }

          // Check if user is the post owner
          if (post.oxyUserId.toString() !== userId) {
            return res.status(403).json({
              error: 'Forbidden',
              message: 'You can only create polls for your own posts'
            });
          }
        } catch (error) {
          console.error('Error validating post:', error);
          return res.status(400).json({
            error: 'Invalid request',
            message: 'Invalid post ID format'
          });
        }
      }

      // Create poll options
      const pollOptions = options.map((option: string) => ({
        text: option,
        votes: []
      }));

      try {
        // Create poll
        const poll = await Poll.create({
          question,
          options: pollOptions,
          postId: finalPostId,
          createdBy: userId,
          endsAt: endsAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Default 7 days
          isMultipleChoice: isMultipleChoice || false,
          isAnonymous: isAnonymous || false
        });

        // If we have a valid post, update its metadata
        if (post) {
          await Post.findByIdAndUpdate(postId, {
            $set: { 'metadata.pollId': String(poll._id) }
          });
        }

        res.status(201).json({
          success: true,
          data: poll
        });
      } catch (error: any) {
        console.error('Error creating poll:', error);
        // Provide more detailed error information
        if (error.name === 'ValidationError') {
          return res.status(400).json({
            error: 'Validation Error',
            message: error.message,
            details: error.errors
          });
        }
        next(createError(500, 'Error creating poll'));
      }
    } catch (error) {
      console.error('Error in createPoll:', error);
      next(createError(500, 'Error creating poll'));
    }
  }

  async getPoll(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const poll = await Poll.findById(id);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      res.json({
        success: true,
        data: poll
      });
    } catch (error) {
      console.error('Error fetching poll:', error);
      next(createError(500, 'Error fetching poll'));
    }
  }

  async vote(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { optionId } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      if (!id || !mongoose.Types.ObjectId.isValid(id) || !optionId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Valid poll ID and option ID are required'
        });
      }

      const poll = await Poll.findById(id);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Check if poll has ended
      if (new Date() > poll.endsAt) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'This poll has ended'
        });
      }

      // Find the option
      const option = poll.options.find(opt => (opt as any)._id.toString() === optionId);
      if (!option) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Option not found'
        });
      }

      // Check if user has already voted in this poll
      const hasVoted = poll.options.some(opt => 
        opt.votes.some(vote => vote.toString() === userId)
      );

      if (hasVoted && !poll.isMultipleChoice) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'You have already voted in this poll'
        });
      }

      // Add vote
      option.votes.push(userId);
      await poll.save();

      res.json({
        success: true,
        data: poll
      });
    } catch (error) {
      console.error('Error voting in poll:', error);
      next(createError(500, 'Error voting in poll'));
    }
  }

  async getResults(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const poll = await Poll.findById(id);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Calculate results
      const totalVotes = poll.options.reduce((sum, option) => sum + option.votes.length, 0);
      const results = poll.options.map(option => ({
        id: option._id,
        text: option.text,
        votes: option.votes.length,
        percentage: totalVotes > 0 ? (option.votes.length / totalVotes) * 100 : 0
      }));

      res.json({
        success: true,
        data: {
          id: poll._id,
          question: poll.question,
          results,
          totalVotes,
          endsAt: poll.endsAt,
          isEnded: new Date() > poll.endsAt,
          isAnonymous: poll.isAnonymous
        }
      });
    } catch (error) {
      console.error('Error fetching poll results:', error);
      next(createError(500, 'Error fetching poll results'));
    }
  }

  async deletePoll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const poll = await Poll.findById(id);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Check if user is the poll creator
      if (poll.createdBy.toString() !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only delete your own polls'
        });
      }

      // Remove poll reference from post metadata
      await Post.findByIdAndUpdate(poll.postId, {
        $set: { metadata: null }
      });

      // Delete poll
      await Poll.findByIdAndDelete(id);

      res.json({
        success: true,
        message: 'Poll deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting poll:', error);
      next(createError(500, 'Error deleting poll'));
    }
  }

  async updatePollPostId(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { postId } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      if (!id || !mongoose.Types.ObjectId.isValid(id) || !postId || !mongoose.Types.ObjectId.isValid(postId)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Valid poll ID and post ID are required'
        });
      }

      // Find the poll
      const poll = await Poll.findById(id);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Check if user is the poll creator
      if (poll.createdBy.toString() !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only update your own polls'
        });
      }

      // Check if post exists
      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Post not found'
        });
      }

      // Check if user is the post owner
      if (post.oxyUserId !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only update polls for your own posts'
        });
      }

      // Update the poll with the new post ID
      poll.postId = new mongoose.Types.ObjectId(postId);
      await poll.save();

      // Update post metadata to include poll reference
      await Post.findByIdAndUpdate(postId, {
        $set: { 'metadata.pollId': String(poll._id) }
      });

      res.json({
        success: true,
        data: poll
      });
    } catch (error) {
      console.error('Error updating poll post ID:', error);
      next(createError(500, 'Error updating poll post ID'));
    }
  }
}

export default new PollsController(); 
