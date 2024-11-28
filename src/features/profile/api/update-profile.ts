import axios from "axios";

import { IProfile } from "./../types/index";
import { postImage } from "./post-image";
export const updateProfile = async (profile: IProfile, userId: string) => {
  if (!profile) return;
  try {
    let bannerUrl: string | undefined;
    let avatarUrl: string | undefined;

    if (profile?.banner?.file) {
      bannerUrl = await postImage(profile?.banner?.file, "banners");
    }

    if (profile?.avatar?.file) {
      avatarUrl = await postImage(profile?.avatar?.file, "avatars");
    }

    const { data: dataOxy } = await axios.put(
      process.env.NEXT_PUBLIC_OXY_SERVICES_URL + `/api/users/${userId}`,
      {
        user_id: userId,
        name: profile?.name,
        username: profile?.username,
        avatar: avatarUrl ? avatarUrl : profile?.avatar?.url,
        description: profile?.bio,
        color: profile?.color,
      },
    );

    const { data } = await axios.put(`/api/users/${userId}`, {
      user_id: userId,
      location: profile?.location,
      url: profile?.website,
      profile_banner_url: bannerUrl ? bannerUrl : profile?.banner?.url,
      privacySettings: profile?.privacySettings, // P1858
    });

    return { ...dataOxy, ...data };
  } catch (error: any) {
    return error.Message;
  }
};
