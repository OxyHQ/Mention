export interface Post {
  id: string;
  avatar: string;
  name: string;
  username: string;
  content: string;
  time: string;
  likes: number;
  reposts: number;
  replies: number;
  isReply?: boolean;
  hasMedia?: boolean;
  isLiked?: boolean;
}

export const samplePosts: Post[] = [
  {
    id: "1",
    avatar: "https://picsum.photos/seed/user1/200",
    name: "John Doe",
    username: "@johndoe",
    content: "Just setting up my Twitter clone! 🚀 #coding #reactnative",
    time: "2m",
    likes: 5,
    reposts: 2,
    replies: 1,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
  {
    id: "2",
    avatar: "https://picsum.photos/seed/user2/200",
    name: "Jane Smith",
    username: "@janesmith",
    content:
      "Working on some amazing new features for our app. Stay tuned! 💻✨ #development",
    time: "15m",
    likes: 12,
    reposts: 4,
    replies: 3,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
  {
    id: "3",
    avatar: "https://picsum.photos/seed/user3/200",
    name: "Tech Enthusiast",
    username: "@techlover",
    content:
      "The future of mobile development is cross-platform! React Native is amazing for building beautiful apps quickly. What are your thoughts? 🤔",
    time: "1h",
    likes: 45,
    reposts: 15,
    replies: 8,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
  {
    id: "4",
    avatar: "https://picsum.photos/seed/user4/200",
    name: "Sarah Wilson",
    username: "@sarahw",
    content: "Beautiful sunset today! 🌅\nNature never fails to amaze me.",
    time: "2h",
    likes: 89,
    reposts: 23,
    replies: 5,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
  {
    id: "5",
    avatar: "https://picsum.photos/seed/user5/200",
    name: "Dev Community",
    username: "@devcom",
    content:
      "🔥 Pro tip: Always write clean, maintainable code. Your future self will thank you! #codingbestpractices #cleancode",
    time: "3h",
    likes: 234,
    reposts: 78,
    replies: 12,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
];
