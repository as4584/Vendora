/**
 * Live box scanner: stability voting (pure), the scanner UI with the native
 * VisionKit view mocked, and the native module wrapper's fallbacks.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createFieldVoter, isScanComplete, DEFAULT_STABLE_FRAMES } from '../services/smartScan/stability';

const mockHaptic = jest.fn();
jest.mock('expo-haptics', () => ({
  notificationAsync: (...a: unknown[]) => mockHaptic(...a),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const { Text } = require('react-native');
  const Ionicons = (p: any) => R.createElement(Text, { testID: `icon-${p.name}` });
  Ionicons.glyphMap = {};
  return { Ionicons };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockNativeProps: any = null;
jest.mock('../modules/label-reader', () => {
  const R = require('react');
  const { View } = require('react-native');
  const LiveView = (props: any) => {
    mockNativeProps = props;
    return R.createElement(View, { testID: 'native-live-view' });
  };
  return {
    isLabelReaderAvailable: () => true,
    readLabelText: async () => [],
    isLiveScanAvailable: async () => true,
    getLiveScannerView: () => LiveView,
  };
});

// Real label text from a Jordan 4 box, as VisionKit transcribes it.
const JORDAN_LINES = ['AIR JORDAN 4 RETRO', 'FV5029-006', 'BLACK/CEMENT GREY-WHITE', 'US 10', 'UK 9 EUR 44'];

describe('stability voting', () => {
  it('accepts a field only after N identical consecutive reads', () => {
    const v = createFieldVoter(3);
    expect(v.update({ size: '10' })).toEqual({});
    expect(v.update({ size: '10' })).toEqual({});
    expect(v.update({ size: '10' })).toEqual({ size: '10' });
  });

  it('resets the streak on a different value, but not on a missing one', () => {
    const v = createFieldVoter(3);
    v.update({ style_code: 'DD1391-100' });
    v.update({ style_code: 'DD1391-10O' }); // OCR jitter
    v.update({ style_code: 'DD1391-100' });
    expect(v.stable().style_code).toBeUndefined();
    v.update({}); // label briefly out of view: no vote
    v.update({ style_code: 'DD1391-100' });
    expect(v.update({ style_code: 'DD1391-100' }).style_code).toBe('DD1391-100');
  });

  it('keeps an accepted value until another one is equally stable', () => {
    const v = createFieldVoter(2);
    v.update({ name: 'Dunk Low' });
    v.update({ name: 'Dunk Low' });
    v.update({ name: 'Dunk Lo' });
    expect(v.stable().name).toBe('Dunk Low');
    v.update({ name: 'Dunk Lo' });
    expect(v.stable().name).toBe('Dunk Lo');
  });

  it('normalizes whitespace, ignores blanks and non-strings, and resets', () => {
    const v = createFieldVoter(1);
    expect(v.update({ name: '  Air   Max ', color: '   ', size: 7 as any })).toEqual({ name: 'Air Max' });
    expect(v.sawStyle()).toBe(false);
    v.update({ style_code: 'X' });
    expect(v.sawStyle()).toBe(true);
    v.reset();
    expect(v.stable()).toEqual({});
    expect(v.sawStyle()).toBe(false);
  });

  it('defaults to 3 frames and clamps silly values', () => {
    expect(DEFAULT_STABLE_FRAMES).toBe(3);
    const v = createFieldVoter();
    v.update({ size: '9' });
    v.update({ size: '9' });
    expect(v.stable().size).toBeUndefined();
    expect(createFieldVoter(0).update({ size: '9' })).toEqual({ size: '9' });
  });

  it('is complete with barcode + name + size, plus style when one was seen', () => {
    expect(isScanComplete({ barcode: '1', name: 'A' }, false)).toBe(false);
    expect(isScanComplete({ barcode: '1', name: 'A', size: '10' }, false)).toBe(true);
    expect(isScanComplete({ barcode: '1', name: 'A', size: '10' }, true)).toBe(false);
    expect(isScanComplete({ barcode: '1', name: 'A', size: '10', style_code: 'S' }, true)).toBe(true);
    expect(isScanComplete({ name: 'A', size: '10' }, false)).toBe(false);
  });
});

describe('LiveBoxScanner', () => {
  const { LiveBoxScanner } = require('../components/LiveBoxScanner');
  const send = (lines: string[], barcodes: string[] = []) =>
    act(() => mockNativeProps.onLines({ nativeEvent: { lines, barcodes } }));

  beforeEach(() => {
    mockNativeProps = null;
    mockHaptic.mockClear();
  });

  it('fills the checklist as fields hold steady and closes itself when complete', () => {
    const onFinish = jest.fn();
    const screen = render(
      <LiveBoxScanner onFinish={onFinish} onCancel={jest.fn()} onUnavailable={jest.fn()} />,
    );
    expect(mockNativeProps.active).toBe(true);
    expect(screen.getByText('Reading your box')).toBeTruthy();
    expect(screen.getByLabelText('Box label progress').props.accessibilityValue).toEqual({ min: 0, max: 3, now: 0 });
    expect(screen.getByTestId('live-check-name')).toHaveTextContent(/Looking/);
    expect(screen.getByTestId('live-check-color')).toHaveTextContent(/If shown/);

    send(JORDAN_LINES, ['197862948123']);
    send(JORDAN_LINES, ['197862948123']);
    expect(onFinish).not.toHaveBeenCalled();
    send(JORDAN_LINES, ['197862948123']);

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0][0]).toMatchObject({
      barcode: '197862948123',
      style_code: 'FV5029-006',
      size: '10',
    });
    expect(onFinish.mock.calls[0][0].name).toMatch(/Jordan 4 Retro/i);
    expect(mockHaptic).toHaveBeenCalledWith('success');
    expect(screen.getByTestId('live-check-size')).toHaveTextContent('Size10');
    expect(screen.getByText('Label ready')).toBeTruthy();
    expect(screen.getByLabelText('Box label progress').props.accessibilityValue).toEqual({ min: 0, max: 4, now: 4 });

    // Late frames after finishing are ignored.
    send(JORDAN_LINES, ['197862948123']);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('waits for the style code once the label shows one', () => {
    const onFinish = jest.fn();
    const screen = render(<LiveBoxScanner onFinish={onFinish} onCancel={jest.fn()} onUnavailable={jest.fn()} stableFrames={2} />);
    send(['AIR JORDAN 4 RETRO', 'US 10', 'FV5029-006'], ['1']);
    send(['AIR JORDAN 4 RETRO', 'US 10', 'FV5029-008'], ['1']); // style jitters
    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Box label progress').props.accessibilityValue).toEqual({ min: 0, max: 4, now: 3 });
    send(['AIR JORDAN 4 RETRO', 'US 10', 'FV5029-008'], ['1']);
    expect(onFinish).toHaveBeenCalled();
  });

  it('Done finishes early with whatever is stable, once', () => {
    const onFinish = jest.fn();
    const screen = render(
      <LiveBoxScanner onFinish={onFinish} onCancel={jest.fn()} onUnavailable={jest.fn()} stableFrames={1} />,
    );
    act(() => mockNativeProps.onLines({ nativeEvent: undefined }));
    send(['US 9.5']);
    fireEvent.press(screen.getByText('Done'));
    fireEvent.press(screen.getByText('Done'));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ size: '9.5' });
  });

  it('shows completion without optional color or an unseen style code', () => {
    const onFinish = jest.fn();
    const screen = render(<LiveBoxScanner onFinish={onFinish} onCancel={jest.fn()} onUnavailable={jest.fn()} stableFrames={1} />);
    send(['AIR JORDAN 4 RETRO', 'US 10'], ['197862948123']);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Label ready')).toBeTruthy();
    expect(screen.getByLabelText('Box label progress').props.accessibilityValue).toEqual({ min: 0, max: 3, now: 3 });
    expect(screen.getByTestId('live-check-color')).toHaveTextContent(/If shown/);
  });

  it('cancels, and reports native errors as unavailable', () => {
    const onCancel = jest.fn();
    const onUnavailable = jest.fn();
    const screen = render(<LiveBoxScanner onFinish={jest.fn()} onCancel={onCancel} onUnavailable={onUnavailable} />);
    fireEvent.press(screen.getByLabelText('Cancel scan'));
    expect(onCancel).toHaveBeenCalled();
    act(() => mockNativeProps.onScanError({ nativeEvent: { code: 'permission', message: 'Allow camera access' } }));
    expect(onUnavailable).toHaveBeenCalledWith('Allow camera access');
    act(() => mockNativeProps.onScanError({ nativeEvent: undefined }));
    expect(onUnavailable).toHaveBeenLastCalledWith("Live scanning isn't available.");
  });
});

describe('label-reader native wrapper', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('expo-modules-core');
  });

  function load(native: unknown) {
    jest.resetModules();
    jest.unmock('../modules/label-reader');
    const viewManager = jest.fn(() => 'LiveView');
    jest.doMock('expo-modules-core', () => ({
      requireOptionalNativeModule: () => native,
      requireNativeViewManager: viewManager,
    }));
    return { mod: require('../modules/label-reader'), viewManager };
  }

  it('reports nothing available without the native module', async () => {
    const { mod } = load(null);
    expect(mod.isLabelReaderAvailable()).toBe(false);
    expect(await mod.readLabelText('file:///x.jpg')).toEqual([]);
    expect(await mod.isLiveScanAvailable()).toBe(false);
    expect(mod.getLiveScannerView()).toBeNull();
  });

  it('asks the native module and caches the view', async () => {
    const native = {
      isAvailable: true,
      recognize: jest.fn(async () => ['US 10']),
      isLiveScanAvailable: jest.fn(async () => true),
    };
    const { mod, viewManager } = load(native);
    expect(mod.isLabelReaderAvailable()).toBe(true);
    expect(await mod.readLabelText('file:///x.jpg')).toEqual(['US 10']);
    expect(await mod.isLiveScanAvailable()).toBe(true);
    expect(mod.getLiveScannerView()).toBe('LiveView');
    expect(mod.getLiveScannerView()).toBe('LiveView');
    expect(viewManager).toHaveBeenCalledTimes(1);
    native.isLiveScanAvailable.mockRejectedValueOnce(new Error('boom'));
    expect(await mod.isLiveScanAvailable()).toBe(false);
  });
});
