import axios from "axios";

const API_URL = "http://localhost:3000/api";
const API_URL_OXY = "http://localhost:3000/api";

const getApiUrl = (useOxy: boolean) => (useOxy ? API_URL_OXY : API_URL);

export const fetchData = async (endpoint: string, data?: any, useOxy: boolean = false) => {
  try {
    const response = await axios.get(`${getApiUrl(useOxy)}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${endpoint}:`, error);
    throw error;
  }
};

export const deleteData = async (endpoint: string, data?: any, useOxy: boolean = false) => {
  try {
    const response = await axios.delete(`${getApiUrl(useOxy)}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error(`Error deleting data from ${endpoint}:`, error);
    throw error;
  }
};

export const postData = async (endpoint: string, data: any, useOxy: boolean = false) => {
  try {
    const response = await axios.post(`${getApiUrl(useOxy)}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error(`Error posting data to ${endpoint}:`, error);
    throw error;
  }
};

export const putData = async (endpoint: string, data: any, useOxy: boolean = false) => {
  try {
    const response = await axios.put(`${getApiUrl(useOxy)}/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error(`Error putting data to ${endpoint}:`, error);
    throw error;
  }
};


