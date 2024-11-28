import axios from "axios";

export const deleteHashtags = async (hashtags: string[]) => {
  try {
    const { data } = await axios.delete(`/api/hashtags`, {
      data: { hashtags },
    });
    return data;
  } catch (error: any) {
    return error.response.data;
  }
};
