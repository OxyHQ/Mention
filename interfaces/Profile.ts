export interface Profile {
  id: string;
  name: string;
  avatar: string;
  username: string;
  bio?: string;
  location?: string;
  website?: string;
  joinDate?: string;
  _count?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
}
