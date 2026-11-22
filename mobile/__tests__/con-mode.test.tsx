import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isConMode, loadConMode, resetConModeForTests, setConMode, subscribeConMode, useConMode } from '../services/conMode';
import { cachedComps, clearCompsCache, FRESH_MS, MAX_AGE_MS, resetCompsCacheForTests } from '../services/compsCache';

describe('con mode switch', () => {
  beforeEach(async () => {
    resetConModeForTests();
    await AsyncStorage.clear();
  });

  it('persists, notifies and ignores no-op sets', async () => {
    const cb = jest.fn();
    const stop = subscribeConMode(cb);
    setConMode(true);
    setConMode(true);
    expect(isConMode()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(await AsyncStorage.getItem('resqlo.con_mode.v1')).toBe('1');
    stop();
    resetConModeForTests();
    expect(await loadConMode()).toBe(true);
    expect(await loadConMode()).toBe(true);
  });

  it('keeps the current value when storage fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('x'));
    expect(await loadConMode()).toBe(false);
  });

  it('exposes a hook', () => {
    const { result } = renderHook(useConMode);
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe('comps cache', () => {
  let t = 1_000_000;
  const now = () => t;
  beforeEach(async () => {
    resetCompsCacheForTests();
    await AsyncStorage.clear();
    t = 1_000_000;
  });

  it('serves fresh hits without fetching', async () => {
    const fetcher = jest.fn().mockResolvedValue({ n: 1 });
    expect(await cachedComps('k', fetcher, { now })).toEqual({ n: 1 });
    t += FRESH_MS - 1;
    expect(await cachedComps('k', fetcher, { now })).toEqual({ n: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('in con mode returns stale at once and refreshes behind', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 });
    await cachedComps('k', fetcher, { now });
    t += FRESH_MS + 1;
    expect(await cachedComps('k', fetcher, { now, preferCache: true })).toEqual({ n: 1 });
    await new Promise((r) => setImmediate(r));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await cachedComps('k', jest.fn(), { now })).toEqual({ n: 2 });
  });

  it('refetches stale entries normally and falls back to them on error', async () => {
    await cachedComps('k', async () => ({ n: 1 }), { now });
    t += FRESH_MS + 1;
    expect(await cachedComps('k', async () => ({ n: 3 }), { now })).toEqual({ n: 3 });
    t += FRESH_MS + 1;
    expect(await cachedComps('k', async () => { throw new Error('no signal'); }, { now })).toEqual({ n: 3 });
    t += MAX_AGE_MS;
    await expect(cachedComps('k', async () => { throw new Error('no signal'); }, { now })).rejects.toThrow('no signal');
    await expect(cachedComps('k', async () => { throw new Error('x'); }, { now, preferCache: true })).rejects.toThrow('x');
  });

  it('survives restarts, bad storage, and can be cleared', async () => {
    await cachedComps('k', async () => ({ n: 1 }), { now });
    await Promise.resolve();
    resetCompsCacheForTests();
    const fetcher = jest.fn();
    expect(await cachedComps('k', fetcher, { now })).toEqual({ n: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    clearCompsCache();
    resetCompsCacheForTests();
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('x'));
    expect(await cachedComps('k', async () => ({ n: 9 }), { now })).toEqual({ n: 9 });
  });

  it('keeps only the newest 200 entries', async () => {
    for (let i = 0; i < 205; i++) {
      t += 1;
      await cachedComps(`k${i}`, async () => i, { now });
    }
    const fetcher = jest.fn().mockResolvedValue('again');
    await cachedComps('k0', fetcher, { now });
    expect(fetcher).toHaveBeenCalled();
  });
});

describe('storage failures never surface', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await AsyncStorage.clear();
    resetConModeForTests();
    resetCompsCacheForTests();
  });
  afterEach(() => jest.restoreAllMocks());

  it('swallows write, clear and background-refresh failures', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(new Error('disk full'));
    setConMode(true);
    let t = 0;
    const now = () => t;
    await cachedComps('fail-k', async () => 1, { now });
    t += FRESH_MS + 1;
    expect(await cachedComps('fail-k', async () => { throw new Error('offline'); }, { now, preferCache: true })).toBe(1);
    clearCompsCache();
    await new Promise((r) => setImmediate(r));
  });
});
