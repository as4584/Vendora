import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BrandIntro, BrandLoader, INTRO_MS, hasSeenIntro, introGreeting, markIntroSeen } from '../components/BrandIntro';

function motion(reduced: boolean) {
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }) as never);
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced);
}

describe('brand intro', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('greets a known business by name, otherwise uses the brand line', () => {
    expect(introGreeting('  Kicks Co. ')).toBe('Welcome back, Kicks Co.');
    expect(introGreeting(null)).toBe('Every pair. Every sale. Every dollar.');
    expect(introGreeting('   ')).toBe('Every pair. Every sale. Every dollar.');
  });

  it('remembers that the intro was seen', async () => {
    expect(await hasSeenIntro()).toBe(false);
    await markIntroSeen();
    expect(await hasSeenIntro()).toBe(true);
  });

  it('never blocks launch when storage fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('x'));
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('x'));
    expect(await hasSeenIntro()).toBe(true);
    await expect(markIntroSeen()).resolves.toBeUndefined();
  });

  it('animates, marks itself seen and finishes', async () => {
    motion(false);
    const onDone = jest.fn();
    const screen = render(<BrandIntro businessName="Sole Vault" onDone={onDone} />);
    await act(async () => {});
    expect(screen.getByText('RESQLO')).toBeTruthy();
    expect(screen.getByText('Welcome back, Sole Vault')).toBeTruthy();
    act(() => jest.advanceTimersByTime(INTRO_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(await hasSeenIntro()).toBe(true);
    screen.unmount();
  });

  it('shows a still frame briefly with Reduce Motion on', async () => {
    motion(true);
    const onDone = jest.fn();
    render(<BrandIntro onDone={onDone} />);
    await act(async () => {});
    act(() => jest.advanceTimersByTime(1000));
    expect(onDone).toHaveBeenCalled();
  });

  it('renders the breathing loader with and without motion', async () => {
    motion(false);
    const a = render(<BrandLoader />);
    await act(async () => {});
    expect(a.getByLabelText('Loading Resqlo')).toBeTruthy();
    a.unmount();
    motion(true);
    const b = render(<BrandLoader />);
    await act(async () => {});
    expect(b.getByLabelText('Loading Resqlo')).toBeTruthy();
  });
});
