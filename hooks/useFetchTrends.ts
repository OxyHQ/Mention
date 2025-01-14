import { useState, useEffect } from "react";
import { fetchData } from "@/utils/api";
import { storeData } from "@/utils/storage";
import { Trend } from "@/interfaces/Trend";

export const useFetchTrends = () => {
  const [trends, setTrends] = useState<Trend[]>([]);

  const fetchTrends = async () => {
    try {
      const data = await fetchData("hashtags");
      const trends = data.map((trend: any) => ({
        id: trend.id,
        text: trend.text,
        hashtag: trend.hashtag,
        score: trend.score,
        created_at: trend.created_at,
      }));
      setTrends(trends);
      await storeData("trends", trends);
    } catch (error) {
      console.error("Error fetching trends:", error);
    }
  };

  useEffect(() => {
    fetchTrends();
  }, []);

  return trends;
};
