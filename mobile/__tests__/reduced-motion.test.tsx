import { AccessibilityInfo } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { useReducedMotion } from '../components/useReducedMotion';

describe('motion preference', () => {
  let change: (value: boolean) => void;
  let resolve: (value: boolean) => void;
  let reject: (error: Error) => void;
  const remove = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_, listener) => {
      change = listener;
      return { remove };
    });
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => new Promise((yes, no) => {
      resolve = yes; reject = no;
    }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('stays still until known and responds to preference changes', async () => {
    const { result, unmount } = renderHook(useReducedMotion);
    expect(result.current).toBe(true);
    await act(async () => resolve(false));
    expect(result.current).toBe(false);
    act(() => change(true));
    expect(result.current).toBe(true);
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('ignores a stale query after a live preference change', async () => {
    const { result } = renderHook(useReducedMotion);
    act(() => change(true));
    await act(async () => resolve(false));
    expect(result.current).toBe(true);
  });
  it('stays still if reading the setting fails', async () => {
    const { result } = renderHook(useReducedMotion);
    await act(async () => reject(new Error('unavailable')));
    expect(result.current).toBe(true);
  });
});
