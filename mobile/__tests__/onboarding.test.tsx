import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import { allowedDuringOnboarding, checkOnboarding, markOnboarded } from '../services/onboarding';
import OnboardingScreen from '../app/onboarding';

jest.mock('../services/api');
jest.mock('../services/telemetry', () => ({ track: jest.fn() }));

const mockStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
  },
}));

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useFocusEffect: (cb: () => void) => { const R = require('react'); R.useEffect(cb, []); },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
const mockSignOut = jest.fn();
jest.mock('../context/auth', () => ({ useAuth: () => ({ user: { id: 'u1' }, signOut: mockSignOut }) }));

const page = (items: object[], total = items.length) => ({ items, total, page: 1, per_page: 100, pages: 1 });

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockStore).forEach((k) => delete mockStore[k]);
});

describe('onboarding gate', () => {
  it('requires setup for a brand-new account with no items', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(page([]));
    await expect(checkOnboarding('u1')).resolves.toBe('needed');
  });

  it('skips setup for accounts that already have inventory and remembers it', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(page([{ id: 'a' }], 40));
    await expect(checkOnboarding('u1')).resolves.toBe('done');
    (apiMock.listItems as jest.Mock).mockClear();
    await expect(checkOnboarding('u1')).resolves.toBe('done');
    expect(apiMock.listItems).not.toHaveBeenCalled();
  });

  it('never traps anyone when the server cannot be reached', async () => {
    (apiMock.listItems as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(checkOnboarding('u1')).resolves.toBe('done');
  });

  it('is done once marked, even with zero items', async () => {
    await markOnboarded('u1');
    (apiMock.listItems as jest.Mock).mockResolvedValue(page([]));
    await expect(checkOnboarding('u1')).resolves.toBe('done');
  });

  it('only allows the setup screen and the ways to add inventory', () => {
    expect(allowedDuringOnboarding(['onboarding'])).toBe(true);
    expect(allowedDuringOnboarding(['(tabs)', 'inventory', 'add'])).toBe(true);
    expect(allowedDuringOnboarding(['(tabs)', 'inventory', 'import'])).toBe(true);
    expect(allowedDuringOnboarding(['(tabs)', 'inventory', 'batch-scan'])).toBe(true);
    expect(allowedDuringOnboarding(['(tabs)', 'dashboard'])).toBe(false);
    expect(allowedDuringOnboarding(['(tabs)', 'inventory'])).toBe(false);
    expect(allowedDuringOnboarding(['(tabs)', 'settings'])).toBe(false);
  });
});

describe('OnboardingScreen', () => {
  it('offers import, scan and batch scan with no skip', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(page([]));
    const s = render(<OnboardingScreen />);
    await s.findByTestId('onboarding-choose');
    expect(s.queryByText(/skip/i)).toBeNull();
    fireEvent.press(s.getByTestId('onboarding-import'));
    expect(mockPush).toHaveBeenCalledWith('/inventory/import');
    fireEvent.press(s.getByTestId('onboarding-scan'));
    expect(mockPush).toHaveBeenCalledWith('/inventory/add');
    fireEvent.press(s.getByText('Sign out'));
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('shows what they now have, then opens the dashboard', async () => {
    (apiMock.listItems as jest.Mock).mockResolvedValue(
      page([
        { id: 'a', quantity: 2, expected_sell_price: '200.00', buy_price: '120.00' },
        { id: 'b', quantity: 1, expected_sell_price: null, buy_price: '50.00' },
      ]),
    );
    const s = render(<OnboardingScreen />);
    await s.findByTestId('onboarding-done');
    expect(s.getByText('$450')).toBeTruthy();
    expect(s.getByText('3')).toBeTruthy();
    fireEvent.press(s.getByTestId('onboarding-finish'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard'));
    expect(mockStore['vendora.onboarded.u1']).toBe('1');
  });
});
