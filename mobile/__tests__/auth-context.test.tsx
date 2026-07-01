import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { AuthProvider, useAuth } from '../context/auth';
import * as api from '../services/api';

jest.mock('../services/api', () => ({
  getToken: jest.fn(),
  getMe: jest.fn(),
  clearToken: jest.fn(),
  onUnauthorized: jest.fn(),
  login: jest.fn(),
  setSession: jest.fn(),
  register: jest.fn(),
  logoutSession: jest.fn(),
}));

const mockedApi = api as jest.Mocked<typeof api>;
const USER = {
  id: 'user-1',
  email: 'owner@vendora.test',
  business_name: 'Vendora Test',
  profile_picture: null,
  subscription_tier: 'free',
  is_partner: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

let currentAuth: ReturnType<typeof useAuth>;

function Probe() {
  currentAuth = useAuth();
  return (
    <Text testID="state">
      {currentAuth.isLoading ? 'loading' : currentAuth.isAuthenticated ? currentAuth.user?.email : 'signed-out'}
    </Text>
  );
}

async function renderProvider() {
  const screen = render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('state').props.children).not.toBe('loading'));
  return screen;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedApi.getToken.mockResolvedValue(null);
    mockedApi.clearToken.mockResolvedValue(undefined);
    mockedApi.setSession.mockResolvedValue(undefined);
    mockedApi.logoutSession.mockResolvedValue(undefined);
    mockedApi.register.mockResolvedValue(USER);
    mockedApi.login.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'bearer',
    });
    mockedApi.getMe.mockResolvedValue(USER);
  });

  it('requires useAuth consumers to be inside the provider', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    function InvalidConsumer() {
      useAuth();
      return null;
    }
    expect(() => render(<InvalidConsumer />)).toThrow('useAuth must be used within AuthProvider');
    consoleSpy.mockRestore();
  });

  it('finishes signed out when no stored access token exists', async () => {
    const screen = await renderProvider();
    expect(screen.getByTestId('state').props.children).toBe('signed-out');
    expect(mockedApi.getMe).not.toHaveBeenCalled();
  });

  it('restores a valid stored session on mount', async () => {
    mockedApi.getToken.mockResolvedValue('stored-token');
    const screen = await renderProvider();
    expect(screen.getByTestId('state').props.children).toBe(USER.email);
    expect(currentAuth.token).toBe('stored-token');
  });

  it('clears an invalid stored session on mount', async () => {
    mockedApi.getToken.mockResolvedValue('bad-token');
    mockedApi.getMe.mockRejectedValueOnce(new Error('expired'));
    const screen = await renderProvider();
    expect(screen.getByTestId('state').props.children).toBe('signed-out');
    expect(mockedApi.clearToken).toHaveBeenCalledTimes(1);
  });

  it('responds to the global unauthorized callback', async () => {
    mockedApi.getToken.mockResolvedValue('stored-token');
    const screen = await renderProvider();
    const handler = mockedApi.onUnauthorized.mock.calls[0][0];
    act(() => handler());
    expect(screen.getByTestId('state').props.children).toBe('signed-out');
  });

  it('signs in, persists both tokens, and loads the user', async () => {
    const screen = await renderProvider();
    await act(async () => currentAuth.signIn('owner@vendora.test', 'secret123'));
    expect(mockedApi.login).toHaveBeenCalledWith('owner@vendora.test', 'secret123');
    expect(mockedApi.setSession).toHaveBeenCalledWith('access-token', 'refresh-token');
    expect(screen.getByTestId('state').props.children).toBe(USER.email);
  });

  it('removes a partial session if profile loading fails after login', async () => {
    await renderProvider();
    mockedApi.getMe.mockRejectedValueOnce(new Error('profile unavailable'));
    await expect(currentAuth.signIn('owner@vendora.test', 'secret123')).rejects.toThrow(
      'profile unavailable',
    );
    expect(mockedApi.clearToken).toHaveBeenCalledTimes(1);
    expect(currentAuth.isAuthenticated).toBe(false);
  });

  it('registers and then signs the new user in', async () => {
    await renderProvider();
    await act(async () => currentAuth.signUp('new@vendora.test', 'secret123', 'New Shop'));
    expect(mockedApi.register).toHaveBeenCalledWith('new@vendora.test', 'secret123', 'New Shop');
    expect(mockedApi.login).toHaveBeenCalledWith('new@vendora.test', 'secret123');
    expect(currentAuth.isAuthenticated).toBe(true);
  });

  it('revokes and clears state when signing out', async () => {
    mockedApi.getToken.mockResolvedValue('stored-token');
    await renderProvider();
    await act(async () => currentAuth.signOut());
    expect(mockedApi.logoutSession).toHaveBeenCalledTimes(1);
    expect(currentAuth.isAuthenticated).toBe(false);
  });

  it('refreshes the user and tolerates a refresh failure', async () => {
    mockedApi.getToken.mockResolvedValue('stored-token');
    await renderProvider();
    const updated = { ...USER, business_name: 'Updated Shop' };
    mockedApi.getMe.mockResolvedValueOnce(updated);
    await act(async () => currentAuth.refreshUser());
    expect(currentAuth.user?.business_name).toBe('Updated Shop');

    mockedApi.getMe.mockRejectedValueOnce(new Error('offline'));
    await expect(act(async () => currentAuth.refreshUser())).resolves.toBeUndefined();
    expect(currentAuth.user?.business_name).toBe('Updated Shop');
  });
});
