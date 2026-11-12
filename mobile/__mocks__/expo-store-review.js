// Mock for expo-store-review (native module).
module.exports = {
  isAvailableAsync: jest.fn(async () => true),
  hasAction: jest.fn(async () => true),
  requestReview: jest.fn(async () => undefined),
};
