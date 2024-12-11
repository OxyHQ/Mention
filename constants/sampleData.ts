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
  showActions?: boolean;
  images?: string[];
  poll?: { question: string; options: string[] };
  location?: string;
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
    poll: {
      question: "What's your favorite mobile development framework?",
      options: ["React Native", "Flutter", "Xamarin", "NativeScript"],
    },
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
    images: Array.from(
      { length: 3 },
      (_, i) => `https://picsum.photos/seed/user2/${200 + i}`
    ),
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
  {
    id: "6",
    avatar: "https://picsum.photos/seed/user6/200",
    name: "Alice Johnson",
    username: "@alicej",
    content:
      "Just finished a great workout session! 💪 #fitness #healthyliving",
    time: "4h",
    likes: 150,
    reposts: 30,
    replies: 10,
    isReply: false,
    hasMedia: false,
    isLiked: false,
  },
  {
    id: "7",
    avatar: "https://picsum.photos/seed/user7/200",
    name: "Bob Brown",
    username: "@bobb",
    content:
      "Exploring the new features in the latest React Native release. Exciting stuff! 🚀",
    time: "5h",
    likes: 75,
    reposts: 20,
    replies: 5,
    isReply: false,
    hasMedia: false,
    isLiked: false,
  },
  {
    id: "8",
    avatar: "https://picsum.photos/seed/user8/200",
    name: "Charlie Davis",
    username: "@charlied",
    content:
      "Had a productive day coding! Time to relax with some good music. 🎧",
    time: "6h",
    likes: 60,
    reposts: 15,
    replies: 4,
    isReply: false,
    hasMedia: false,
    isLiked: false,
  },
  {
    id: "9",
    avatar: "https://picsum.photos/seed/user9/200",
    name: "Dana Lee",
    username: "@danal",
    content: "Loving the new design of our app! Great job team! 🎨 #UIDesign",
    time: "7h",
    likes: 90,
    reposts: 25,
    replies: 6,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
  {
    id: "10",
    avatar: "https://picsum.photos/seed/user10/200",
    name: "Evan Green",
    username: "@evang",
    content:
      "Reading a fascinating book on software architecture. 📚 #techreads",
    time: "8h",
    likes: 120,
    reposts: 40,
    replies: 8,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  },
];

export interface Trend {
  hashtag: string;
  count: number;
}

export const sampleTrends: Trend[] = [
  { hashtag: "#coding", count: 1200 },
  { hashtag: "#reactnative", count: 950 },
  { hashtag: "#development", count: 800 },
  { hashtag: "#tech", count: 700 },
  { hashtag: "#fitness", count: 650 },
  { hashtag: "#healthyliving", count: 600 },
  { hashtag: "#UIDesign", count: 550 },
  { hashtag: "#cleancode", count: 500 },
  { hashtag: "#softwarearchitecture", count: 450 },
  { hashtag: "#techreads", count: 400 },
];
