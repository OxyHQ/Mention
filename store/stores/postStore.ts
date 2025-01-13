import create from 'zustand'
export interface IPost {
  name: string
  userNameAndDate: string
  profileUrl: string
  content: string
  time: string
}

interface IStore {
  posts: IPost[]
  addPost: (post: IPost) => unknown
  getPosts: () => IPost[]
}
export const usePostsStore = create<IStore>((set, get) => ({
  posts: [],
  addPost: (post) => set((state) => ({posts: [...state.posts, post]})),
  getPosts: () => get().posts,
}))