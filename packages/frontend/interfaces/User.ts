export interface User {
  id: string;
  username: string;
  name: {
    first: string;
    last: string;
  } | string;
  email: string;
  avatar: string;
  description?: string;
  location?: string;
  website?: string;
  verified?: boolean;
  premium?: {
    isPremium: boolean;
    subscriptionTier?: string;
    features: string[];
  };
  labels?: string[];
  stats?: {
    followers: number;
    following: number;
    posts: number;
  };
  preferences?: {
    theme: 'light' | 'dark' | 'auto';
    language: string;
    notifications: boolean;
  };
  created_at: string;
  updated_at: string;
}

export default User; 