import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { openProviderConnect, waitForWebPopup } from '../utils/oauthConnect';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: jest.fn(() => 'vendora://settings') }));

type Listener = (event: any) => void;

function fakeWindow() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener: jest.fn((type: string, fn: Listener) => { (listeners[type] ||= []).push(fn); }),
    removeEventListener: jest.fn((type: string, fn: Listener) => {
      listeners[type] = (listeners[type] || []).filter((l) => l !== fn);
    }),
    emit(type: string, event: any) { (listeners[type] || []).forEach((l) => l(event)); },
  };
}

describe('waitForWebPopup', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves on the callback page postMessage and ignores other messages', async () => {
    const win = fakeWindow();
    const done = waitForWebPopup({ closed: false } as Window, win as unknown as Window);
    win.emit('message', { data: 'noise' });
    win.emit('message', { data: { type: 'other' } });
    win.emit('message', { data: { type: 'resqlo-oauth', provider: 'ebay', status: 'connected' } });
    await expect(done).resolves.toBe('connected');
    expect(win.listeners.message).toHaveLength(0);
  });

  it('resolves on the localStorage event', async () => {
    const win = fakeWindow();
    const done = waitForWebPopup({ closed: false } as Window, win as unknown as Window);
    win.emit('storage', { key: 'unrelated', newValue: '{}' });
    win.emit('storage', { key: 'resqlo-oauth', newValue: 'not json' });
    win.emit('storage', { key: 'resqlo-oauth', newValue: JSON.stringify({ type: 'resqlo-oauth', status: 'denied' }) });
    await expect(done).resolves.toBe('denied');
  });

  it('resolves when the popup is closed by hand, or after the timeout', async () => {
    const popup = { closed: false };
    const done = waitForWebPopup(popup as Window, fakeWindow() as unknown as Window);
    popup.closed = true;
    jest.advanceTimersByTime(600);
    await expect(done).resolves.toBe('closed');

    const stuck = waitForWebPopup({ closed: false } as Window, fakeWindow() as unknown as Window);
    jest.advanceTimersByTime(10 * 60 * 1000 + 1);
    await expect(stuck).resolves.toBe('closed');
  });
});

describe('openProviderConnect', () => {
  const originalOS = Platform.OS;
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    jest.restoreAllMocks();
  });

  it('uses an auth session on native and reads the outcome from the deep link', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    (WebBrowser.openAuthSessionAsync as jest.Mock)
      .mockResolvedValueOnce({ type: 'success', url: 'vendora://settings?integration=ebay&status=connected' })
      .mockResolvedValueOnce({ type: 'success', url: 'vendora://settings?integration=stockx&status=denied' })
      .mockResolvedValueOnce({ type: 'cancel' });
    await expect(openProviderConnect('https://ebay.test')).resolves.toBe('connected');
    await expect(openProviderConnect('https://stockx.test')).resolves.toBe('denied');
    await expect(openProviderConnect('https://x.test')).resolves.toBe('closed');
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://ebay.test', 'vendora://settings');
  });

  it('opens a popup on web and waits for it', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const popup = { closed: false };
    const open = jest.fn(() => popup);
    const g = global as any;
    const prev = { open: g.window?.open, add: g.window?.addEventListener, remove: g.window?.removeEventListener };
    g.window = g.window || {};
    const win = fakeWindow();
    g.window.open = open;
    g.window.addEventListener = win.addEventListener;
    g.window.removeEventListener = win.removeEventListener;
    try {
      const done = openProviderConnect('https://ebay.test/consent');
      win.emit('message', { data: { type: 'resqlo-oauth', status: 'connected' } });
      await expect(done).resolves.toBe('connected');
      expect(open).toHaveBeenCalledWith('https://ebay.test/consent', 'resqlo-oauth', expect.any(String));
      expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();

      // Popup blocked: navigate this tab instead.
      g.window.open = jest.fn(() => null);
      const assign = jest.fn();
      g.window.location = { assign };
      await expect(openProviderConnect('https://ebay.test/consent')).resolves.toBe('closed');
      expect(assign).toHaveBeenCalledWith('https://ebay.test/consent');
    } finally {
      g.window.open = prev.open;
      g.window.addEventListener = prev.add;
      g.window.removeEventListener = prev.remove;
    }
  });
});
