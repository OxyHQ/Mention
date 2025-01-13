import create from 'zustand'
export interface IPost {
  name: string
  userNameAndDate: string
  profileUrl: string
  content: string
  time: string
}

const initialPosts = [
   {
     name: 'Nate Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
   },{
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
  },
  {
     name: 'Ehsan Sarshar',
     username: 'nate',
     profileUrl:
       'https://pbs.twimg.com/profile_images/1868456361954033664/9tEObRof_400x400.jpg',
     content:
       'Javascript is every where here is a post about it https://stackoverflow.com/questions/36631762/returning-html-with-fetch',
     time: new Date().toISOString(),
   },
]

interface IStore {
  posts: IPost[]
  addPost: (post: IPost) => unknown
  getPosts: () => IPost[]
}
export const useStore = create<IStore>((set, get) => ({
  posts: initialPosts,
  addPost: (post) => set((state) => ({posts: [...state.posts, post]})),
  getPosts: () => get().posts,
}))
