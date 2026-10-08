// Mock for @react-native-async-storage/async-storage
const store = {};

const AsyncStorage = {
  getItem: jest.fn(async (key) => store[key] ?? null),
  setItem: jest.fn(async (key, value) => { store[key] = value; }),
  removeItem: jest.fn(async (key) => { delete store[key]; }),
  multiRemove: jest.fn(async (keys) => { keys.forEach((k) => delete store[k]); }),
  multiGet: jest.fn(async (keys) => keys.map((k) => [k, store[k] ?? null])),
  multiSet: jest.fn(async (pairs) => { pairs.forEach(([k, v]) => { store[k] = v; }); }),
  clear: jest.fn(async () => { Object.keys(store).forEach((k) => delete store[k]); }),
  getAllKeys: jest.fn(async () => Object.keys(store)),
};

export default AsyncStorage;
