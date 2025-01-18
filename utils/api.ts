import axios from "axios";

const API_URL = "https://mention.earth/api";
const API_URL_OXY = "http://localhost:3000/api";

export const fetchData = async (endpoint: string) => {
  try {
    const response = await axios.get(`${API_URL}/${endpoint}`);
    return response.data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
};

export const sendData = async (endpoint: string, data: any) => {
  try {
    const response = await axios.post(`${API_URL}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error("Error sending data:", error);
    throw error;
  }
}


export const fetchDataOxy = async (endpoint: string) => {
  try {
    const response = await axios.get(`${API_URL_OXY}/${endpoint}`);
    return response.data;
  } catch (error) {
    console.error("Error fetching data from Oxy API:", error);
    throw error;
  }
};

export const sendDataOxy = async (endpoint: string, data: any) => {
  try {
    const response = await axios.post(`${API_URL_OXY}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error("Error sending data:", error);
    throw error;
  }
}