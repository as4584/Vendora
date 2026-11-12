/**
 * Units for the 1.2 polish layer: screen snapshots, sounds, light/dark
 * reload, skeletons, backdrop, swipe accessibility actions, onboarding events.
 */
import React from 'react';
import { AppState, DevSettings } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

const mockStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
    getAllKeys: jest.fn(async () => Object.keys(mockStore)),
    multiRemove: jest.fn(async (keys: string[]) => keys.forEach((k) => delete mockStore[k])),
  },
}));

const mockPlay = jest.fn();
const mockSeek = jest.fn();
const mockCreatePlayer = jest.fn(() => ({ play: mockPlay, seekTo: mockSeek }));
const mockSetMode = jest.fn(async () => undefined);
jest.mock('expo-audio', () => ({ createAudioPlayer: mockCreatePlayer, setAudioModeAsync: mockSetMode }));
jest.mock('expo-blur', () => ({ BlurView: () => null }));

describe('screen snapshots', () => {
  const snap = () => require('../services/offline/snapshot') as typeof import('../services/offline/snapshot');

  it('reads from memory at once, from disk on a cold start, and clears on sign-out', async () => {
    const s = snap();
    expect(s.peekSnapshot('x')).toBeUndefined();
    s.saveSnapshot('x', { n: 1 });
    expect(s.peekSnapshot('x')).toEqual({ n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(mockStore['offline:snap:x'])).toEqual({ n: 1 });

    mockStore['offline:snap:cold'] = JSON.stringify({ n: 2 });
    await expect(s.loadSnapshot('cold')).resolves.toEqual({ n: 2 });
    expect(s.peekSnapshot('cold')).toEqual({ n: 2 });
    await expect(s.loadSnapshot('missing')).resolves.toBeUndefined();

    mockStore['other'] = 'keep';
    await s.clearSnapshots();
    expect(s.peekSnapshot('x')).toBeUndefined();
    expect(Object.keys(mockStore)).toEqual(['other']);
  });

  it('sign-out wipes snapshots along with the offline store', async () => {
    const s = snap();
    s.saveSnapshot('y', 1);
    await require('../services/offline').clearOfflineData();
    expect(s.peekSnapshot('y')).toBeUndefined();
  });
});

describe('sounds', () => {
  it('plays from the start, respects the silent switch, reuses players', () => {
    const { playSound } = require('../services/sounds');
    playSound('scan');
    playSound('scan');
    playSound('sale');
    expect(mockSetMode).toHaveBeenCalledWith({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' });
    expect(mockCreatePlayer).toHaveBeenCalledTimes(2);
    expect(mockSeek).toHaveBeenCalledWith(0);
    expect(mockPlay).toHaveBeenCalledTimes(3);
  });

  it('never throws when audio is unavailable', () => {
    mockPlay.mockImplementationOnce(() => { throw new Error('no audio'); });
    const { playSound } = require('../services/sounds');
    expect(() => playSound('scan')).not.toThrow();
  });
});

describe('light/dark reload', () => {
  it('reloads only when returning to the app after the phone switched modes', () => {
    const { Appearance } = require('react-native');
    const { useSchemeReload, currentScheme } = require('../theme/useSchemeReload');
    const { SCHEME } = require('../theme/tokens');
    const listeners: ((s: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, cb: (s: string) => void) => {
      listeners.push(cb);
      return { remove: jest.fn() };
    }) as never);
    const reload = jest.spyOn(DevSettings, 'reload').mockImplementation(() => undefined);
    function Probe() {
      useSchemeReload();
      return null;
    }
    render(<Probe />);
    const other = SCHEME === 'light' ? 'dark' : 'light';

    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue(SCHEME);
    listeners.forEach((cb) => cb('active'));
    expect(reload).not.toHaveBeenCalled();

    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue(other);
    expect(currentScheme()).toBe(other);
    listeners.forEach((cb) => cb('background'));
    expect(reload).not.toHaveBeenCalled();
    listeners.forEach((cb) => cb('active'));
    expect(reload).toHaveBeenCalled();
  });
});

describe('visual building blocks', () => {
  it('renders every skeleton as a busy, labelled placeholder', () => {
    const { SkeletonList, SkeletonDashboard, SkeletonDetail, Bone } = require('../components/Skeleton');
    const s = render(
      <>
        <SkeletonList testID="l" rows={2} />
        <SkeletonDashboard testID="d" />
        <SkeletonDetail testID="t" />
        <Bone />
      </>,
    );
    for (const id of ['l', 'd', 't']) {
      expect(s.getByTestId(id).props.accessibilityLabel).toBe('Loading');
      expect(s.getByTestId(id).props.accessibilityState).toEqual({ busy: true });
    }
  });

  it('backdrop renders the photo layer with children on top', () => {
    const { Text } = require('react-native');
    const { Backdrop, GlassBlur } = require('../components/Backdrop');
    const s = render(
      <Backdrop>
        <GlassBlur />
        <Text>content</Text>
      </Backdrop>,
    );
    expect(s.getByText('content')).toBeTruthy();
  });

  it('swipe actions are reachable without swiping (VoiceOver actions)', () => {
    const { Text } = require('react-native');
    const { SwipeRow } = require('../components/SwipeRow');
    const sell = jest.fn();
    const del = jest.fn();
    const s = render(
      <SwipeRow
        testID="row"
        left={[{ key: 'sell', label: 'Sell', icon: 'cash-outline', color: '#000', onPress: sell }]}
        right={[{ key: 'delete', label: 'Delete', icon: 'trash-outline', color: '#000', onPress: del }]}
      >
        <Text>row</Text>
      </SwipeRow>,
    );
    const row = s.getByTestId('row');
    expect(row.props.accessibilityActions).toEqual([{ name: 'sell', label: 'Sell' }, { name: 'delete', label: 'Delete' }]);
    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });
    expect(del).toHaveBeenCalled();
    fireEvent.press(s.getByTestId('swipe-sell'));
    expect(sell).toHaveBeenCalled();
  });
});

describe('onboarding events', () => {
  it('tells subscribers when setup is finished, and unsubscribes', async () => {
    jest.doMock('../services/api', () => ({ listItems: jest.fn() }));
    const { subscribeOnboarding, markOnboarded } = require('../services/onboarding');
    const cb = jest.fn();
    const off = subscribeOnboarding(cb);
    await markOnboarded('u9');
    expect(cb).toHaveBeenCalledWith('done');
    off();
    await markOnboarded('u9');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
