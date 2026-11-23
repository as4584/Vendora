import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import MoreScreen from '../app/(tabs)/more';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('../services/api', () => ({ isCatalogAdmin: jest.fn(async () => false) }));

describe('MoreScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists every secondary destination and routes on tap', async () => {
    const screen = render(<MoreScreen />);
    ['Show Summary', 'Invoices', 'Sync Center', 'Advanced Analytics', 'Plans & Billing', 'Settings', 'Support'].forEach((label) => {
      expect(screen.getByText(label)).toBeTruthy();
    });
    fireEvent.press(screen.getByText('Invoices'));
    fireEvent.press(screen.getByText('Settings'));
    expect(screen.queryByText('Catalog Admin')).toBeNull();
    expect(mockPush.mock.calls).toEqual(
      expect.arrayContaining([['/inventory/invoices'], ['/settings']]),
    );
  });

  it('shows Catalog Admin only to catalog admins', async () => {
    (apiMock.isCatalogAdmin as jest.Mock).mockResolvedValueOnce(true);
    const screen = render(<MoreScreen />);
    fireEvent.press(await screen.findByText('Catalog Admin'));
    expect(mockPush).toHaveBeenCalledWith('/settings/catalog-admin');
    (apiMock.isCatalogAdmin as jest.Mock).mockResolvedValueOnce(true);
    render(<MoreScreen />).unmount();
  });
});
