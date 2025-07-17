import { Types } from 'mongoose';

export interface MockUser {
  _id: Types.ObjectId;
  username: string;
  name: {
    first: string;
    last: string;
  };
  email: string;
  avatar: string;
  description: string;
  location: string;
  website?: string;
  verified: boolean;
  premium?: {
    isPremium: boolean;
    subscriptionTier: string;
  };
  labels: string[];
  stats: {
    followers: number;
    following: number;
    posts: number;
  };
  created_at: Date;
  updated_at: Date;
}

export interface MockMediaItem {
  id: string;
  type: 'image' | 'video' | 'file';
  url: string;
  thumbnail?: string;
  filename?: string;
  size?: number;
  duration?: number;
  alt?: string;
}

export interface MockPost {
  _id: Types.ObjectId;
  text: string;
  userID: Types.ObjectId;
  media: MockMediaItem[];
  hashtags: string[];
  mentions: string[];
  likes: Types.ObjectId[];
  reposts: Types.ObjectId[];
  replies: Types.ObjectId[];
  bookmarks: Types.ObjectId[];
  location?: {
    type: 'Point';
    coordinates: [number, number];
    name: string;
  };
  created_at: Date;
  updated_at: Date;
  isDraft: boolean;
  scheduledFor?: Date;
  status: 'published' | 'draft' | 'scheduled';
  in_reply_to_status_id?: Types.ObjectId;
  quoted_post_id?: Types.ObjectId;
  source: string;
  lang: string;
  possibly_sensitive: boolean;
}

const sampleTexts = [
  "Just shipped a new feature! 🚀 The team has been working hard on this one. #development #tech",
  "Beautiful sunset today 🌅 Sometimes you just need to stop and appreciate the little things in life.",
  "Coffee and code, the perfect combination ☕️ #programming #coffee #productivity",
  "Excited to announce our new partnership! This is going to be amazing for our users. #partnership #growth",
  "Working on some interesting problems today. Love the challenge! 💪 #work #challenge #growth",
  "Great meeting with the team today. Amazing what we can accomplish when we work together! #teamwork",
  "Just finished reading an incredible book. Highly recommend it to anyone interested in tech leadership. #books #leadership",
  "The weather is perfect for a walk in the park. Nature is the best therapist 🌳 #nature #wellness",
  "Debugging is like being a detective in a crime movie where you are also the murderer 🔍 #programming #humor",
  "New day, new opportunities! What are you working on today? #motivation #goals",
  "Just tried a new restaurant in town. The food was absolutely incredible! 🍽️ #food #restaurant",
  "Grateful for the support from the community. You all are amazing! 🙏 #gratitude #community",
  "Working late tonight, but excited about what we're building! #startup #hustle #passion",
  "Sometimes the best ideas come when you least expect them. Always keep a notebook handy! 💡 #creativity #ideas",
  "Celebrating small wins today. Progress is progress, no matter how small! 🎉 #progress #celebration",
];

const sampleUsers = [
  {
    username: "sarah_dev",
    name: { first: "Sarah", last: "Johnson" },
    description: "Full-stack developer | Coffee enthusiast | Dog mom 🐕",
    location: "San Francisco, CA",
    verified: true,
    premium: { isPremium: true, subscriptionTier: "Pro" }
  },
  {
    username: "mike_design",
    name: { first: "Mike", last: "Chen" },
    description: "UI/UX Designer | Digital nomad 🌍 | Always learning",
    location: "New York, NY",
    verified: false,
    premium: { isPremium: false, subscriptionTier: "Free" }
  },
  {
    username: "alex_startup",
    name: { first: "Alex", last: "Rodriguez" },
    description: "Founder & CEO | Building the future of tech 🚀",
    location: "Austin, TX",
    verified: true,
    premium: { isPremium: true, subscriptionTier: "Premium" }
  },
  {
    username: "emma_writer",
    name: { first: "Emma", last: "Thompson" },
    description: "Tech writer | Blogger | Storyteller 📝",
    location: "London, UK",
    verified: false,
    premium: { isPremium: false, subscriptionTier: "Free" }
  },
  {
    username: "david_product",
    name: { first: "David", last: "Kim" },
    description: "Product Manager | Data-driven decisions | Cycling enthusiast 🚴‍♂️",
    location: "Seattle, WA",
    verified: true,
    premium: { isPremium: true, subscriptionTier: "Pro" }
  },
  {
    username: "lisa_marketing",
    name: { first: "Lisa", last: "Davis" },
    description: "Marketing specialist | Brand strategist | Yoga instructor 🧘‍♀️",
    location: "Los Angeles, CA",
    verified: false,
    premium: { isPremium: false, subscriptionTier: "Free" }
  },
  {
    username: "john_cto",
    name: { first: "John", last: "Wilson" },
    description: "CTO | Scaling technology teams | Dad of 3 👨‍👩‍👧‍👦",
    location: "Boston, MA",
    verified: true,
    premium: { isPremium: true, subscriptionTier: "Premium" }
  },
  {
    username: "nina_ai",
    name: { first: "Nina", last: "Patel" },
    description: "AI researcher | Machine learning enthusiast | Chess player ♟️",
    location: "Palo Alto, CA",
    verified: true,
    premium: { isPremium: true, subscriptionTier: "Pro" }
  }
];

const sampleMediaUrls = [
  {
    type: 'image' as const,
    url: 'https://picsum.photos/800/600?random=1',
    thumbnail: 'https://picsum.photos/200/150?random=1',
    alt: 'Beautiful landscape'
  },
  {
    type: 'image' as const,
    url: 'https://picsum.photos/800/800?random=2',
    thumbnail: 'https://picsum.photos/200/200?random=2',
    alt: 'City skyline'
  },
  {
    type: 'image' as const,
    url: 'https://picsum.photos/600/400?random=3',
    thumbnail: 'https://picsum.photos/200/133?random=3',
    alt: 'Nature scene'
  },
  {
    type: 'video' as const,
    url: 'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
    thumbnail: 'https://picsum.photos/200/150?random=4',
    duration: 30,
    alt: 'Sample video'
  },
  {
    type: 'file' as const,
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    filename: 'sample_document.pdf',
    size: 1024,
    alt: 'PDF document'
  }
];

const sampleHashtags = [
  'tech', 'programming', 'startup', 'design', 'ai', 'productivity', 'development',
  'javascript', 'react', 'nodejs', 'python', 'coffee', 'work', 'team', 'growth',
  'innovation', 'creativity', 'motivation', 'success', 'learning', 'books',
  'nature', 'travel', 'food', 'fitness', 'wellness', 'community', 'collaboration'
];

const sampleLocations = [
  { coordinates: [-122.4194, 37.7749], name: "San Francisco, CA" },
  { coordinates: [-74.0060, 40.7128], name: "New York, NY" },
  { coordinates: [-97.7431, 30.2672], name: "Austin, TX" },
  { coordinates: [-0.1276, 51.5074], name: "London, UK" },
  { coordinates: [-122.3321, 47.6062], name: "Seattle, WA" },
  { coordinates: [-118.2437, 34.0522], name: "Los Angeles, CA" },
  { coordinates: [-71.0589, 42.3601], name: "Boston, MA" },
  { coordinates: [-122.1430, 37.4419], name: "Palo Alto, CA" }
];

function randomChoice<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBool(probability: number = 0.5): boolean {
  return Math.random() < probability;
}

export function generateMockUser(): MockUser {
  const user = randomChoice(sampleUsers);
  const userId = new Types.ObjectId();
  
  return {
    _id: userId,
    username: user.username,
    name: user.name,
    email: `${user.username}@example.com`,
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`,
    description: user.description,
    location: user.location,
    website: randomBool(0.3) ? `https://${user.username}.dev` : undefined,
    verified: user.verified,
    premium: user.premium,
    labels: user.verified ? ['verified'] : [],
    stats: {
      followers: randomInt(10, 10000),
      following: randomInt(5, 1000),
      posts: randomInt(1, 5000)
    },
    created_at: new Date(Date.now() - randomInt(0, 365 * 24 * 60 * 60 * 1000)),
    updated_at: new Date()
  };
}

export function generateMockPost(users: MockUser[]): MockPost {
  const author = randomChoice(users);
  const postId = new Types.ObjectId();
  const text = randomChoice(sampleTexts);
  
  // Generate media (0-4 items)
  const mediaCount = randomInt(0, 4);
  const media: MockMediaItem[] = [];
  
  for (let i = 0; i < mediaCount; i++) {
    const mediaItem = randomChoice(sampleMediaUrls);
    media.push({
      id: new Types.ObjectId().toString(),
      ...mediaItem
    });
  }
  
  // Generate hashtags
  const hashtagCount = randomInt(0, 3);
  const hashtags: string[] = [];
  for (let i = 0; i < hashtagCount; i++) {
    const hashtag = randomChoice(sampleHashtags);
    if (!hashtags.includes(hashtag)) {
      hashtags.push(hashtag);
    }
  }
  
  // Generate mentions
  const mentionCount = randomInt(0, 2);
  const mentions: string[] = [];
  for (let i = 0; i < mentionCount; i++) {
    const mentionedUser = randomChoice(users.filter(u => u._id !== author._id));
    if (!mentions.includes(mentionedUser.username)) {
      mentions.push(mentionedUser.username);
    }
  }
  
  // Generate engagement
  const likeCount = randomInt(0, 500);
  const repostCount = randomInt(0, 100);
  const replyCount = randomInt(0, 50);
  const bookmarkCount = randomInt(0, 200);
  
  const likes = Array.from({ length: likeCount }, () => new Types.ObjectId());
  const reposts = Array.from({ length: repostCount }, () => new Types.ObjectId());
  const replies = Array.from({ length: replyCount }, () => new Types.ObjectId());
  const bookmarks = Array.from({ length: bookmarkCount }, () => new Types.ObjectId());
  
  return {
    _id: postId,
    text,
    userID: author._id,
    media,
    hashtags,
    mentions,
    likes,
    reposts,
    replies,
    bookmarks,
    location: randomBool(0.2) ? {
      type: 'Point',
      coordinates: randomChoice(sampleLocations).coordinates as [number, number],
      name: randomChoice(sampleLocations).name
    } : undefined,
    created_at: new Date(Date.now() - randomInt(0, 30 * 24 * 60 * 60 * 1000)),
    updated_at: new Date(),
    isDraft: false,
    status: 'published',
    source: 'web',
    lang: 'en',
    possibly_sensitive: false
  };
}

export function generateMockData(userCount: number = 50, postCount: number = 200) {
  const users = Array.from({ length: userCount }, () => generateMockUser());
  const posts = Array.from({ length: postCount }, () => generateMockPost(users));
  
  return { users, posts };
}

export function generateReply(parentPost: MockPost, users: MockUser[]): MockPost {
  const author = randomChoice(users);
  const replyTexts = [
    "Great point! I totally agree with this perspective.",
    "Thanks for sharing this! Really helpful.",
    "Interesting take on this topic. What do you think about...?",
    "This is exactly what I was looking for. Much appreciated!",
    "Love this! Keep up the great work.",
    "Can you share more details about this?",
    "This reminds me of a similar experience I had.",
    "Couldn't agree more! Well said.",
    "Thanks for the insight. Very valuable.",
    "This is really inspiring. Thanks for sharing!"
  ];
  
  const reply = generateMockPost(users);
  reply.text = randomChoice(replyTexts);
  reply.in_reply_to_status_id = parentPost._id;
  reply.media = []; // Replies typically have less media
  reply.created_at = new Date(parentPost.created_at.getTime() + randomInt(0, 24 * 60 * 60 * 1000));
  
  return reply;
} 