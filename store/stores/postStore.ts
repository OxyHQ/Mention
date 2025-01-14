import create from 'zustand'
import { Post as IPost } from "@/interfaces/Post";

interface IStore {
  posts: IPost[]
  addPost: (post: IPost) => unknown
  getPosts: () => IPost[]
  getPostById: (id: string) => IPost | undefined
}
export const usePostsStore = create<IStore>((set, get) => ({
  posts: [],
  addPost: (post) => set((state) => ({posts: [...state.posts, post]})),
  getPosts: () => get().posts,
  getPostById: (id: string) => get().posts.find((post) => post.id === id),
}))