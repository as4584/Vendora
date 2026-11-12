import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';
import { ASK_INTERVAL_MS, SALES_BEFORE_ASK, maybeAskForRating, recordSale } from '../services/rating';

const mockTrack = jest.fn();
jest.mock('../services/telemetry', () => ({ track: (...a: unknown[]) => mockTrack(...a) }));
const SR = StoreReview as unknown as Record<string, jest.Mock>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  SR.isAvailableAsync.mockResolvedValue(true);
  SR.hasAction.mockResolvedValue(true);
});

async function sales(n: number) {
  for (let i = 0; i < n; i += 1) await recordSale();
}

it('waits for a few sales', async () => {
  await sales(SALES_BEFORE_ASK - 1);
  expect(await maybeAskForRating()).toBe(false);
  await sales(1);
  expect(await maybeAskForRating()).toBe(true);
  expect(SR.requestReview).toHaveBeenCalledTimes(1);
  expect(mockTrack).toHaveBeenCalledWith('rating_prompt_shown', { sales: SALES_BEFORE_ASK });
});

it('asks at most every 120 days', async () => {
  await sales(5);
  const t0 = 1_700_000_000_000;
  expect(await maybeAskForRating(t0)).toBe(true);
  expect(await maybeAskForRating(t0 + 1000)).toBe(false);
  expect(await maybeAskForRating(t0 + ASK_INTERVAL_MS + 1)).toBe(true);
  expect(SR.requestReview).toHaveBeenCalledTimes(2);
});

it('skips when the store cannot show it', async () => {
  await sales(5);
  SR.isAvailableAsync.mockResolvedValueOnce(false);
  expect(await maybeAskForRating()).toBe(false);
  SR.hasAction.mockResolvedValueOnce(false);
  expect(await maybeAskForRating()).toBe(false);
  expect(SR.requestReview).not.toHaveBeenCalled();
});

it('never throws', async () => {
  await sales(5);
  SR.requestReview.mockRejectedValueOnce(new Error('x'));
  expect(await maybeAskForRating()).toBe(false);
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk'));
  await expect(recordSale()).resolves.toBeUndefined();
});
