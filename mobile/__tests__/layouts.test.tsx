import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import RootLayout from '../app/_layout';
import Index from '../app/index';
import AuthLayout from '../app/(auth)/_layout';
import TabsLayout from '../app/(tabs)/_layout';

const mockReplace = jest.fn();
const mockRedirect = jest.fn(() => null);
const mockStack = jest.fn(() => null);
const mockTabsScreen = jest.fn(() => null);
const mockSegments: string[] = [];
let mockAuthState = { isAuthenticated: false, isLoading: false };

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

describe('router layouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSegments.splice(0);
    mockAuthState = { isAuthenticated: false, isLoading: false };
  });

  it('shows a loader while authentication state is being restored', () => {
    mockAuthState = { isAuthenticated: false, isLoading: true };
    const screen = render(<RootLayout />);
    expect(screen.UNSAFE_getByType(require('react-native').ActivityIndicator)).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
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
    render(<TabsLayout />);
    expect(mockTabsScreen).toHaveBeenCalledTimes(13);
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
      'inventory/import',
      'settings/sync-center',
      'settings/subscription',
      'settings/analytics',
      'settings/support',
    ]);
    const hidden = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/[id]')?.[0];
    expect(hidden.options.href).toBeNull();
    // Invoices and Settings are now reachable via the "More" menu, not the tab bar.
    const invoices = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/invoices')?.[0];
    expect(invoices.options.href).toBeNull();
    // The Add tab renders a custom floating FAB button instead of a standard icon.
    const add = mockTabsScreen.mock.calls.find(([props]) => props.name === 'inventory/add')?.[0];
    expect(add.options.tabBarButton({ onPress: jest.fn() })).toBeTruthy();
    const dashboard = mockTabsScreen.mock.calls[0][0];
    expect(dashboard.options.tabBarIcon({ focused: true })).toBeTruthy();
  });
});
