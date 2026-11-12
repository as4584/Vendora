// Mock for @sentry/react-native (native module; not loadable in jest).
module.exports = {
  init: jest.fn(),
  setUser: jest.fn(),
  captureException: jest.fn(),
  wrap: (c) => c,
};
