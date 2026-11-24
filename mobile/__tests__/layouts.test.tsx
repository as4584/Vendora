import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import RootLayout from '../app/_layout';
import Index from '../app/index';
import AuthLayout from '../app/(auth)/_layout';
import TabsLayout from '../app/(tabs)/_layout';

const mockReplace = jest.fn();
const mockRedirect = jest.fn(() => null);
const mockStack = jest.fn(() => null);
const mockTabsScreen = jest.fn(() => null);
const mockSegments: string[] = [];
let mockAuthState: { isAuthenticated: boolean; isLoading: boolean; user?: { id: string } } = {
  isAuthenticated: false, isLoading: false,
};

jest.mock('expo-router', () => {
  const ReactModule = require('react');
  const Tabs = ({ children }: { children: React.ReactNode }) =>
    ReactModule.createElement(ReactModule.Fragment, null, children);
  Tabs.Screen = (props: unknown) => mockTabsScreen(props);
  return {
    Slot: () => null,
    Redirect: (props: unknown) => mockRedirect(props),
    Stack: (props: unknown) => mockStack(props),
    Tabs,
    useSegments: () => mockSegments,
    useRouter: () => ({ replace: mockReplace }),
  };
});

jest.mock('../context/auth', () => {
  const ReactModule = require('react');
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useAuth: () => mockAuthState,
  };
});

jest.mock('../services/onboarding', () => ({
  checkOnboarding: jest.fn(async () => 'done'),
  subscribeOnboarding: jest.fn(() => () => undefined),
  allowedDuringOnboarding: jest.fn(() => true),
}));
jest.mock('../services/pushAlerts', () => ({
  syncPushToken: jest.fn(async () => false),
  maybePromptSaleAlerts: jest.fn(async () => undefined),
}));
let mockIntroSeen = true;
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(async () => true), hideAsync: jest.fn(async () => true) }));
jest.mock('../components/BrandIntro', () => {
  const { Text } = require('react-native');
  return {
    hasSeenIntro: async () => mockIntroSeen,
    BrandLoader: () => <Text>brand-loader</Text>,
    BrandIntro: ({ onDone }: { onDone: () => void }) => <Text onPress={onDone}>brand-intro</Text>,
  };
});
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 4, left: 0 }),
  };
});
jest.mock('../components/ui', () => ({ TabGlyph: () => null, Icon: () => null }));
jest.mock('../services/offline', () => ({
  initOfflineSync: jest.fn(),
  isOnline: () => true,
  subscribeNetwork: () => () => {},
  subscribeSync: () => () => {},
  getSyncState: async () => ({ pending: 0, lastSync: null }),
}));

describe('router layouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSegments.splice(0);
    mockAuthState = { isAuthenticated: false, isLoading: false };
    mockIntroSeen = true;
  });

  it('shows a loader while authentication state is being restored', async () => {
    mockAuthState = { isAuthenticated: false, isLoading: true };
    const screen = render(<RootLayout />);
    await act(async () => {});
    expect(screen.getByText('brand-loader')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('plays the branded intro on first open, then continues into the app', async () => {
    mockIntroSeen = false;
    mockSegments.push('(tabs)');
    const screen = render(<RootLayout />);
    await waitFor(() => expect(screen.getByText('brand-intro')).toBeTruthy());
    fireEvent.press(screen.getByText('brand-intro'));
    await waitFor(() => expect(screen.queryByText('brand-intro')).toBeNull());
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });

  it('redirects signed-out users to login outside the auth group', async () => {
    mockSegments.push('(tabs)');
    render(<RootLayout />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/login'));
  });

  it('keeps signed-out users in auth and sends signed-in users to dashboard', async () => {
    mockSegments.push('(auth)');
    const screen = render(<RootLayout />);
    await waitFor(() => expect(mockReplace).not.toHaveBeenCalled());

    mockAuthState = { isAuthenticated: true, isLoading: false };
    screen.rerender(<RootLayout />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard'));
  });

  it('renders the root index redirect and auth stack configuration', () => {
    render(<Index />);
    expect(mockRedirect).toHaveBeenCalledWith({ href: '/(auth)/login' });

    render(<AuthLayout />);
    expect(mockStack).toHaveBeenCalledWith(
      expect.objectContaining({
        screenOptions: expect.objectContaining({ headerShown: false, animation: 'slide_from_right' }),
      }),
    );
  });

  it('registers visible and hidden tab routes with safe-area padding', () => {
    mockAuthState = { isAuthenticated: true, isLoading: false, user: { id: 'seller' } };
    render(<TabsLayout />);
    expect(mockTabsScreen).toHaveBeenCalledTimes(21);
    const routeNames = mockTabsScreen.mock.calls.map(([props]) => props.name);
    expect(routeNames).toEqual([
      'dashboard',
      'inventory/index',
      'inventory/add',
      'inventory/sale',
      'more',
      'inventory/invoices',
      'settings',
      'inventory/[id]',
      'inventory/edit',
      'inventory/invoice-preview',
      'inventory/components/ItemQuickSheet',
      'inventory/import',
      'inventory/batch-scan',
        'inventory/add-costs',
      'inventory/aging',
      'inventory/trade',
      'inventory/labels',
      'settings/sync-center',
      'settings/import-sales',
      'settings/subscription',
      'settings/analytics',
      'settings/support',
      'settings/show-summary',
      'settings/tax-pack',
      'customers/index',
      'customers/[id]',
    ]);
    const hidden = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/[id]')?.[0];
    expect(hidden.options.href).toBeNull();
    // Invoices and Settings are now reachable via the "More" menu, not the tab bar.
    const invoices = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/invoices')?.[0];
    expect(invoices.options.href).toBeNull();
    // The Add tab renders a custom floating FAB button instead of a standard icon.
    const add = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/add')?.[0];
    const onFabPress = jest.fn();
    const fab = render(add.options.tabBarButton({ onPress: onFabPress }));
    fireEvent.press(fab.getByLabelText('Add stock'));
    expect(onFabPress).toHaveBeenCalled();
    // Non-tab routes must never leak into the tab bar.
    for (const name of ['inventory/edit', 'inventory/invoice-preview', 'inventory/components/ItemQuickSheet']) {
      expect(mockTabsScreen.mock.calls.find(([props]) => props.name === name)?.[0].options.href).toBeNull();
    }
    const dashboard = mockTabsScreen.mock.calls[0][0];
    expect(dashboard.options.tabBarIcon({ focused: true })).toBeTruthy();
  });

  it('does not mount any private tab routes while signed out', () => {
    render(<TabsLayout />);
    expect(mockTabsScreen).not.toHaveBeenCalled();
  });
});
