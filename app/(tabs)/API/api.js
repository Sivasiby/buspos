import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = 'https://untouchably-easier-cheree.ngrok-free.dev';

const getHeaders = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
  };
  try {
    const token = await AsyncStorage.getItem('token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch (e) {
    console.warn('Could not read token:', e);
  }
  return headers;
};

const handleResponse = async (response) => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const err = new Error(error?.error || error?.message || `HTTP ${response.status}`);
    err.response = { status: response.status, data: error };
    throw err;
  }
  return { data: await response.json() };
};

const api = {
  get: async (url) => {
    const headers = await getHeaders();
    const response = await fetch(`${BASE_URL}${url}`, { method: 'GET', headers });
    return handleResponse(response);
  },
  post: async (url, body = {}) => {
    const headers = await getHeaders();
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return handleResponse(response);
  },
  put: async (url, body = {}) => {
    const headers = await getHeaders();
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });
    return handleResponse(response);
  },
  delete: async (url) => {
    const headers = await getHeaders();
    const response = await fetch(`${BASE_URL}${url}`, { method: 'DELETE', headers });
    return handleResponse(response);
  },
};

export default api;