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
    ['Invoices', 'Sync Center', 'Advanced Analytics', 'Plans & Billing', 'Settings', 'Support'].forEach((label) => {
      expect(screen.getByText(label)).toBeTruthy();
    });
    fireEvent.press(screen.getByText('Invoices'));
    fireEvent.press(screen.getByText('Settings'));
    expect(mockPush.mock.calls).toEqual(
      expect.arrayContaining([['/inventory/invoices'], ['/settings']]),
    );
  });
});
