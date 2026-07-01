import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import LoginScreen from '../app/(auth)/login';
import ForgotPasswordScreen from '../app/(auth)/forgot-password';
import ResetPasswordScreen from '../app/(auth)/reset-password';
import RegisterScreen from '../app/(auth)/register';
import * as api from '../services/api';

const mockSignIn = jest.fn();
const mockSignUp = jest.fn();
const mockReplace = jest.fn();
const mockLink = jest.fn(({ children }: { children: React.ReactNode }) => children);
const mockSearchParams = jest.fn((): { token?: string | string[] } => ({ token: 'reset-token' }));

jest.mock('expo-router', () => ({
  Link: (props: { children: React.ReactNode }) => mockLink(props),
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
  useLocalSearchParams: () => mockSearchParams(),
}));

jest.mock('../context/auth', () => ({
  useAuth: () => ({ signIn: mockSignIn, signUp: mockSignUp }),
}));

jest.mock('../services/api', () => ({
  requestPasswordReset: jest.fn(),
  resetPassword: jest.fn(),
}));

const mockedApi = api as jest.Mocked<typeof api>;

describe('authentication screens', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockSignIn.mockResolvedValue(undefined);
    mockSignUp.mockResolvedValue(undefined);
    mockedApi.requestPasswordReset.mockResolvedValue({ message: 'sent' });
    mockedApi.resetPassword.mockResolvedValue({ message: 'reset' });
    mockSearchParams.mockReturnValue({ token: 'reset-token' });
  });

  afterEach(() => alertSpy.mockRestore());

  describe('login', () => {
    it('keeps the forgot-password action visible and points it to the reset request screen', () => {
      const screen = render(<LoginScreen />);
      expect(screen.getByTestId('forgot-password-link')).toBeTruthy();
      expect(screen.getByText('Forgot password?')).toBeTruthy();
      expect(mockLink).toHaveBeenCalledWith(
        expect.objectContaining({ href: '/(auth)/forgot-password' }),
      );
    });

    it('validates required credentials', () => {
      const screen = render(<LoginScreen />);
      fireEvent.press(screen.getByText('Sign In'));
      expect(alertSpy).toHaveBeenCalledWith(
        'Missing Fields',
        'Please enter your email and password.',
      );
      expect(mockSignIn).not.toHaveBeenCalled();
    });

    it('toggles password visibility and signs in with a trimmed email', async () => {
      const screen = render(<LoginScreen />);
      fireEvent.changeText(screen.getByLabelText('Email'), '  owner@vendora.test  ');
      fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
      expect(screen.getByLabelText('Show password')).toBeTruthy();
      fireEvent.press(screen.getByLabelText('Show password'));
      expect(screen.getByLabelText('Hide password')).toBeTruthy();
      fireEvent.press(screen.getByText('Sign In'));
      await waitFor(() =>
        expect(mockSignIn).toHaveBeenCalledWith('owner@vendora.test', 'secret123'),
      );
    });

    it('shows login failures without leaving the form busy', async () => {
      mockSignIn.mockRejectedValueOnce(new Error('Account locked'));
      const screen = render(<LoginScreen />);
      fireEvent.changeText(screen.getByLabelText('Email'), 'owner@vendora.test');
      fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
      fireEvent.press(screen.getByText('Sign In'));
      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Login Failed', 'Account locked'));
      expect(screen.getByText('Sign In')).toBeTruthy();
    });
  });

  describe('forgot password', () => {
    it('requires an email address', () => {
      const screen = render(<ForgotPasswordScreen />);
      fireEvent.press(screen.getByText('Send Reset Link'));
      expect(alertSpy).toHaveBeenCalledWith(
        'Email required',
        'Enter the email address for your Vendora account.',
      );
    });

    it('submits a trimmed email and renders the enumeration-safe success message', async () => {
      const screen = render(<ForgotPasswordScreen />);
      fireEvent.changeText(screen.getByLabelText('Email'), '  tester@vendora.test ');
      fireEvent.press(screen.getByText('Send Reset Link'));
      await waitFor(() => expect(screen.getByText('Check your email')).toBeTruthy());
      expect(mockedApi.requestPasswordReset).toHaveBeenCalledWith('tester@vendora.test');
      expect(screen.getByText(/If a Vendora account exists/)).toBeTruthy();
    });

    it('shows reset-email delivery errors and restores the submit button', async () => {
      mockedApi.requestPasswordReset.mockRejectedValueOnce(new Error('Email unavailable'));
      const screen = render(<ForgotPasswordScreen />);
      fireEvent.changeText(screen.getByLabelText('Email'), 'tester@vendora.test');
      fireEvent.press(screen.getByText('Send Reset Link'));
      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith('Could not send reset email', 'Email unavailable'),
      );
      expect(screen.getByText('Send Reset Link')).toBeTruthy();
    });
  });

  describe('reset password', () => {
    it('renders recovery guidance when the reset token is missing', () => {
      mockSearchParams.mockReturnValue({});
      const screen = render(<ResetPasswordScreen />);
      expect(screen.getByText('Reset link unavailable')).toBeTruthy();
      expect(screen.getByText('Request New Link')).toBeTruthy();
    });

    it('validates weak and mismatched passwords before calling the API', () => {
      const screen = render(<ResetPasswordScreen />);
      fireEvent.changeText(screen.getByLabelText('New Password'), 'short');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'short');
      fireEvent.press(screen.getByText('Reset Password'));
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Weak password',
        'Your password must be at least 8 characters.',
      );

      fireEvent.changeText(screen.getByLabelText('New Password'), 'newsecret1');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'newsecret2');
      fireEvent.press(screen.getByText('Reset Password'));
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Passwords do not match',
        'Enter the same password in both fields.',
      );
      expect(mockedApi.resetPassword).not.toHaveBeenCalled();
    });

    it('accepts array token params, resets the password, and navigates to sign in', async () => {
      mockSearchParams.mockReturnValue({ token: ['array-token', 'ignored'] });
      const screen = render(<ResetPasswordScreen />);
      fireEvent.changeText(screen.getByLabelText('New Password'), 'newsecret1');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'newsecret1');
      fireEvent.press(screen.getByText('Reset Password'));
      await waitFor(() => expect(mockedApi.resetPassword).toHaveBeenCalledWith('array-token', 'newsecret1'));
      const actions = alertSpy.mock.calls.at(-1)?.[2];
      actions[0].onPress();
      expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    });

    it('shows invalid or expired reset errors', async () => {
      mockedApi.resetPassword.mockRejectedValueOnce(new Error('Expired link'));
      const screen = render(<ResetPasswordScreen />);
      fireEvent.changeText(screen.getByLabelText('New Password'), 'newsecret1');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'newsecret1');
      fireEvent.press(screen.getByText('Reset Password'));
      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Reset failed', 'Expired link'));
      expect(screen.getByText('Reset Password')).toBeTruthy();
    });
  });

  describe('registration', () => {
    it('validates required, weak, and mismatched credentials', () => {
      const screen = render(<RegisterScreen />);
      fireEvent.press(screen.getByText('Create Account'));
      expect(alertSpy).toHaveBeenLastCalledWith('Missing Fields', 'Email and password are required.');

      fireEvent.changeText(screen.getByLabelText('Email'), 'new@vendora.test');
      fireEvent.changeText(screen.getByLabelText('Password'), 'short');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'short');
      fireEvent.press(screen.getByText('Create Account'));
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Weak Password',
        'Password must be at least 8 characters.',
      );

      fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'different');
      fireEvent.press(screen.getByText('Create Account'));
      expect(alertSpy).toHaveBeenLastCalledWith('Password Mismatch', "Passwords don't match.");
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it('creates an account with trimmed fields and supports no business name', async () => {
      const screen = render(<RegisterScreen />);
      fireEvent.changeText(screen.getByLabelText('Business Name'), '  Test Shop  ');
      fireEvent.changeText(screen.getByLabelText('Email'), '  new@vendora.test  ');
      fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'secret123');
      fireEvent.press(screen.getByText('Create Account'));
      await waitFor(() =>
        expect(mockSignUp).toHaveBeenCalledWith('new@vendora.test', 'secret123', 'Test Shop'),
      );

      jest.clearAllMocks();
      fireEvent.changeText(screen.getByLabelText('Business Name'), '   ');
      fireEvent.press(screen.getByText('Create Account'));
      await waitFor(() =>
        expect(mockSignUp).toHaveBeenCalledWith('new@vendora.test', 'secret123', undefined),
      );
    });

    it('shows registration failures', async () => {
      mockSignUp.mockRejectedValueOnce(new Error('Email already registered'));
      const screen = render(<RegisterScreen />);
      fireEvent.changeText(screen.getByLabelText('Email'), 'new@vendora.test');
      fireEvent.changeText(screen.getByLabelText('Password'), 'secret123');
      fireEvent.changeText(screen.getByLabelText('Confirm Password'), 'secret123');
      fireEvent.press(screen.getByText('Create Account'));
      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith('Registration Failed', 'Email already registered'),
      );
    });
  });
});
