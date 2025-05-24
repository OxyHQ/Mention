import { Post as IPost } from '@/interfaces/Post';
import React, { createContext, useState } from 'react';

// Use the Post interface from interfaces/Post.ts for consistent typing
interface Post extends IPost { }

interface PostContextProps {
    posts: Record<string, Post>;
    likePost: (id: string) => void;
    replyToPost: (id: string) => void;
    repost: (id: string) => void;
}

export const PostContext = createContext<PostContextProps>({
    posts: {},
    likePost: () => { },
    replyToPost: () => { },
    repost: () => { },
});

export const PostProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [posts, setPosts] = useState<Record<string, Post>>({
        ...Array.from({ length: 35 }, (_, i) => {
            const postId = `${i + 1}`;
            // Make every 5th post a reply to post #1
            const isReply = i % 5 === 0 && i > 0;
            // Make every 7th post a quote of post #2
            const isQuote = i % 7 === 0 && i > 0;
            // Make every 11th post a repost of post #3
            const isRepost = i % 11 === 0 && i > 0;

            return {
                id: postId,
                author: {
                    id: `user${i + 1}`,
                    username: `user${i + 1}`,
                    avatar: `https://example.com/avatar${i + 1}.png`,
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                text: `This is ${isReply ? 'a reply' : isQuote ? 'a quoted post' : isRepost ? 'a repost' : 'a regular post'} by user${i + 1}.`,
                media: i % 2 === 0 ? [`https://quickframe.com/wp-content/uploads/2023/08/QF-Blog_Best-Time-to-Post-on-Threads.jpg`] : [],
                in_reply_to_status_id: isReply ? '1' : null,
                quoted_post_id: isQuote ? '2' : null,
                repost_of: isRepost ? { id: '3', text: 'Original post', media: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as any : null,
                _count: {
                    likes: Math.floor(Math.random() * 100),
                    replies: Math.floor(Math.random() * 50),
                    reposts: Math.floor(Math.random() * 20),
                    quotes: Math.floor(Math.random() * 10),
                    bookmarks: Math.floor(Math.random() * 15),
                },
                source: 'web',
                possibly_sensitive: false,
                lang: 'en',
                userID: `user${i + 1}`,
                quoted_post: null,
                mentions: [],
                hashtags: [],
                replies: [],
                likes: [],
                reposts: [],
                bookmarks: [],
                isDraft: false,
                scheduledFor: null,
                status: 'published',
                isLiked: false,
                isReposted: false,
                isBookmarked: false,
            } as Post;
        }).reduce((acc, post) => ({ ...acc, [post.id]: post }), {}),
    });

    const likePost = (id: string) => {
        setPosts((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
                likes: [...prev[id].likes, 'new_like_id'],
            },
        }));
    };

    const replyToPost = (id: string) => {
        // Handle reply logic
    };

    const repost = (id: string) => {
        setPosts((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
                reposts: [...prev[id].reposts, 'new_repost_id'],
            },
        }));
    };

    return (
        <PostContext.Provider value={{ posts, likePost, replyToPost, repost }}>
            {children}
        </PostContext.Provider>
    );
};
