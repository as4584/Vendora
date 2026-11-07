import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import MoreScreen from '../app/(tabs)/more';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('MoreScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists every secondary destination and routes on tap', () => {
    const screen = render(<MoreScreen />);
    ['Show Summary', 'Customers', 'Invoices', 'Sync Center', 'Advanced Analytics', 'Plans & Billing', 'Settings', 'Support'].forEach((label) => {
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    });
    fireEvent.press(screen.getByText('Invoices'));
    fireEvent.press(screen.getByText('Settings'));
    expect(mockPush.mock.calls).toEqual(
      expect.arrayContaining([['/inventory/invoices'], ['/settings']]),
    );
  });

  it('groups tools under clear headings and keeps show closeout prominent', () => {
    const screen = render(<MoreScreen />);
    ['Sales & customers', 'Business tools', 'Account & help'].forEach(label => {
      expect(screen.getByRole('header', { name: label })).toBeTruthy();
    });
    fireEvent.press(screen.getByRole('button', { name: 'Show Summary' }));
    expect(mockPush).toHaveBeenCalledWith('/settings/show-summary');
  });
});
