import React from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { ScannerOverlay } from '../components/ScannerOverlay';

describe('scanner motion preference', () => {
  let change: (enabled: boolean) => void;
  let resolvePreference: (enabled: boolean) => void;
  let rejectPreference: (error: Error) => void;
  const start = jest.fn();
  const stop = jest.fn();
  const remove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() } as any);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_, callback) => {
      change = callback;
      return { remove };
    });
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => new Promise((resolve, reject) => {
      resolvePreference = resolve;
      rejectPreference = reject;
    }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('starts still, respects enabled preference, and responds to live changes', async () => {
    const screen = render(<ScannerOverlay />);
    expect(start).not.toHaveBeenCalled();
    await act(async () => resolvePreference(true));
    expect(start).not.toHaveBeenCalled();
    act(() => change(false));
    expect(start).toHaveBeenCalledTimes(1);
    act(() => change(true));
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(3);
    screen.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it('animates when reduced motion is disabled', async () => {
    render(<ScannerOverlay />);
    await act(async () => resolvePreference(false));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale initial query override a setting change', async () => {
    render(<ScannerOverlay />);
    act(() => change(true));
    await act(async () => resolvePreference(false));
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start animation after unmount', async () => {
    const screen = render(<ScannerOverlay />);
    screen.unmount();
    await act(async () => resolvePreference(false));
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps the scanner usable and static if the preference query fails', async () => {
    const screen = render(<ScannerOverlay hint="Scan a box" />);
    await act(async () => rejectPreference(new Error('unsupported')));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByText('Scan a box')).toBeTruthy();
  });
});
