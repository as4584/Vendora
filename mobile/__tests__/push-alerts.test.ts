import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as push from '../services/pushAlerts';

jest.mock('expo-constants', () => ({ expoConfig: { extra: { eas: { projectId: 'proj-1' } } } }));
jest.mock('../services/api', () => ({
  registerPushToken: jest.fn(async () => undefined),
  unregisterPushToken: jest.fn(async () => undefined),
  getEbayStatus: jest.fn(async () => ({ connected: true })),
}));
const api = jest.requireMock('../services/api');
const N = Notifications as unknown as Record<string, jest.Mock>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (Platform as { OS: string }).OS = 'ios';
  N.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
  N.requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
  api.getEbayStatus.mockResolvedValue({ connected: true });
});

it('syncs silently only when already granted', async () => {
  expect(await push.syncPushToken()).toBe(false);
  expect(api.registerPushToken).not.toHaveBeenCalled();
  N.getPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
  expect(await push.syncPushToken()).toBe(true);
  expect(N.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
  expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[test]', 'ios');
});

it('enable asks the system and registers on grant', async () => {
  expect(await push.enableSaleAlerts()).toBe(true);
  N.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
  expect(await push.enableSaleAlerts()).toBe(false);
  expect(api.registerPushToken).toHaveBeenCalledTimes(1);
});

it('errors never escape', async () => {
  N.getPermissionsAsync.mockRejectedValueOnce(new Error('x'));
  expect(await push.syncPushToken()).toBe(false);
  N.requestPermissionsAsync.mockRejectedValueOnce(new Error('x'));
  expect(await push.enableSaleAlerts()).toBe(false);
  N.getPermissionsAsync.mockRejectedValueOnce(new Error('x'));
  await expect(push.maybePromptSaleAlerts('u1')).resolves.toBeUndefined();
});

it('prompts once, only with eBay connected, and Turn on enables', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  api.getEbayStatus.mockResolvedValueOnce({ connected: false });
  await push.maybePromptSaleAlerts('u1');
  expect(alert).not.toHaveBeenCalled();

  await push.maybePromptSaleAlerts('u1');
  expect(alert).toHaveBeenCalledTimes(1);
  const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  buttons.find((b) => b.text === 'Turn on')!.onPress!();
  await new Promise((r) => setTimeout(r, 0));
  expect(N.requestPermissionsAsync).toHaveBeenCalled();

  await push.maybePromptSaleAlerts('u1');
  expect(alert).toHaveBeenCalledTimes(1);
});

it('does not prompt when already decided', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  N.getPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
  await push.maybePromptSaleAlerts('u2');
  expect(alert).not.toHaveBeenCalled();
});

it('unregisters the token on sign-out, best effort', async () => {
  await push.unregisterPushToken(); // clear any token left by earlier tests
  api.unregisterPushToken.mockClear();
  await push.unregisterPushToken();
  expect(api.unregisterPushToken).not.toHaveBeenCalled();
  N.getPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
  await push.syncPushToken();
  api.unregisterPushToken.mockRejectedValueOnce(new Error('offline'));
  await expect(push.unregisterPushToken()).resolves.toBeUndefined();
  expect(api.unregisterPushToken).toHaveBeenCalledWith('ExponentPushToken[test]');
});

it('is a no-op on web', async () => {
  (Platform as { OS: string }).OS = 'web';
  expect(await push.syncPushToken()).toBe(false);
  expect(await push.enableSaleAlerts()).toBe(false);
  await push.maybePromptSaleAlerts('u1');
  expect(N.getPermissionsAsync).not.toHaveBeenCalled();
});
