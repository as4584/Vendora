import AsyncStorage from '@react-native-async-storage/async-storage';
import { MAX_RECENT, addRecentSearch, clearRecentSearches, getRecentSearches } from '../services/recentSearches';

beforeEach(async () => { await AsyncStorage.clear(); jest.clearAllMocks(); });

it('keeps newest first, dedupes case-insensitively, and caps the list', async () => {
  await addRecentSearch('jordan');
  await addRecentSearch('dunk');
  expect(await addRecentSearch('JORDAN')).toEqual(['JORDAN', 'dunk']);
  for (let i = 0; i < 10; i += 1) await addRecentSearch(`q${i}`);
  expect(await getRecentSearches()).toHaveLength(MAX_RECENT);
});

it('ignores one-letter searches and clears', async () => {
  expect(await addRecentSearch(' a ')).toEqual([]);
  await addRecentSearch('panda');
  await clearRecentSearches();
  expect(await getRecentSearches()).toEqual([]);
});

it('survives bad or unavailable storage', async () => {
  await AsyncStorage.setItem('vendora.recentSearches', '{not json');
  expect(await getRecentSearches()).toEqual([]);
  await AsyncStorage.setItem('vendora.recentSearches', JSON.stringify({ a: 1 }));
  expect(await getRecentSearches()).toEqual([]);
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('full'));
  expect(await addRecentSearch('yeezy')).toEqual(['yeezy']);
  (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('x'));
  await expect(clearRecentSearches()).resolves.toBeUndefined();
});
