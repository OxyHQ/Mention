import axios from "axios";

const API_URL = "https://mention.earth/api";
const API_URL_OXY = "https://auth.oxy.so/api";

export const fetchData = async (endpoint: string) => {
  try {
    const response = await axios.get(`${API_URL}/${endpoint}`);
    return response.data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};


export const fetchDataOxy = async (endpoint: string) => {
  try {
    const response = await axios.get(`${API_URL_OXY}/${endpoint}`);
    return response.data;
  } catch (error) {
    console.error("Error fetching data from Oxy API:", error);
    throw error;
  }
};