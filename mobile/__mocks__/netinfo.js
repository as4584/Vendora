// Mock for @react-native-community/netinfo — always online in tests.
const state = { isConnected: true, isInternetReachable: true, type: 'wifi' };

const NetInfo = {
  addEventListener: jest.fn(() => () => {}),
  fetch: jest.fn(async () => state),
  refresh: jest.fn(async () => state),
  configure: jest.fn(),
};

export const useNetInfo = jest.fn(() => state);
export default NetInfo;
