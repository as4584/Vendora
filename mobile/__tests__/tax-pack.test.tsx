import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import * as fileActions from '../utils/fileActions';
import TaxPackScreen from '../app/(tabs)/settings/tax-pack';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void) => { const R = require('react'); R.useEffect(cb, [cb]); },
}));
jest.mock('../services/api', () => ({
  getTaxSummary: jest.fn(),
  getToken: jest.fn(async () => 'tok'),
  taxPackCsvUrl: jest.fn((y: number) => `https://api.test/export/tax-pack?year=${y}`),
}));
jest.mock('../utils/fileActions', () => ({ downloadAndShareRemote: jest.fn(async () => undefined) }));
jest.mock('../components/ProUpsell', () => {
  const { Text } = require('react-native');
  return {
    ProUpsell: ({ message }: { message: string }) => <Text>{message}</Text>,
    isProRequired: (e: { detail?: { error?: string } }) => e?.detail?.error === 'pro_required',
  };
});

const totals = { gross_sales: '1234.50', refunds: '50.00', fees: '120.00', cost_of_goods: '400.00', net_profit: '664.50', sales_count: 12 };
const SUMMARY: apiMock.TaxSummary = {
  year: new Date().getFullYear(), ...totals, sales_missing_cost: 2, by_month: [],
  by_channel: [{ channel: 'ebay', label: 'eBay', ...totals, sales_count: 9 }],
};

beforeEach(() => jest.clearAllMocks());

it('shows the year totals, platform split and missing-cost warning, and shares the CSV', async () => {
  (apiMock.getTaxSummary as jest.Mock).mockResolvedValue(SUMMARY);
  const screen = render(<TaxPackScreen />);
  expect(await screen.findByText('$664.50')).toBeTruthy();
  expect(screen.getByText('eBay · 9')).toBeTruthy();
  expect(screen.getByText(/2 sales have no cost recorded/)).toBeTruthy();
  fireEvent.press(screen.getByText('Share CSV for your accountant'));
  const year = new Date().getFullYear();
  await waitFor(() => expect(fileActions.downloadAndShareRemote).toHaveBeenCalledWith(
    `https://api.test/export/tax-pack?year=${year}`, `resqlo_tax_pack_${year}.csv`, 'tok',
  ));
});

it('switches to last year', async () => {
  (apiMock.getTaxSummary as jest.Mock).mockResolvedValue(SUMMARY);
  const screen = render(<TaxPackScreen />);
  await screen.findByText('$664.50');
  const last = new Date().getFullYear() - 1;
  fireEvent.press(screen.getByText(String(last)));
  await waitFor(() => expect(apiMock.getTaxSummary).toHaveBeenLastCalledWith(last));
});

it('shows the Pro upsell for free users', async () => {
  (apiMock.getTaxSummary as jest.Mock).mockRejectedValue({ detail: { error: 'pro_required' } });
  const screen = render(<TaxPackScreen />);
  expect(await screen.findByText(/Tax pack is part of Pro/)).toBeTruthy();
});
