// src/services/api.js
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const api = axios.create({
  // temp_change
  // baseURL: 'https://b09b-103-81-236-85.ngrok-free.app',
  baseURL: 'https://api.zyrap.com',
  timeout: 50000, // Optional: Set a timeout for requests
});

// Add a request interceptor to attach the token
api.interceptors.request.use(
  async config => {
    try {
      const token = await AsyncStorage.getItem('access_token'); // Retrieve the token from AsyncStorage
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`; // Attach token as Bearer token
      }
      return config;
    } catch (error) {
      // console.log(error);
      return Promise.reject(error);
    }
  },
  error => Promise.reject(error),
);

// Response interceptor for error handling
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response && error.response.status === 401) {
      console.error('Unauthorized, logging out...');
      // Add logout logic if needed
    }
    return Promise.reject(error);
  },
);

export default api;
