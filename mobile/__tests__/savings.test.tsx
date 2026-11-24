import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import { SavingsCard } from '../components/SavingsCard';
import { hasSavings, hoursLabel, savingsLines } from '../utils/savings';

jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => { const R = require('react'); R.useEffect(cb, []); },
}));
jest.mock('../services/api', () => ({ getSavings: jest.fn() }));

const base: apiMock.Savings = {
  since: '2026-11-01T00:00:00Z', minutes_saved: 0, items_imported: 0, sales_imported: 0, stock_updates: 0,
  fees_tracked: '0.00', minutes_per_item: 3, minutes_per_sale: 2, minutes_per_stock_update: 0.5,
};

describe('savings copy', () => {
  it('formats minutes and hours', () => {
    expect(hoursLabel(45)).toBe('45 min');
    expect(hoursLabel(60)).toBe('1 hr');
    expect(hoursLabel(210)).toBe('3.5 hrs');
  });
  it('lists only what happened', () => {
    expect(savingsLines({ ...base, items_imported: 1, sales_imported: 6, fees_tracked: '312.40' })).toEqual([
      '1 item imported for you', '6 sales logged automatically', '$312 in fees counted, so profit is real',
    ]);
    expect(hasSavings(base)).toBe(false);
    expect(hasSavings({ ...base, fees_tracked: '1.00' })).toBe(true);
  });
});

describe('SavingsCard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the month total', async () => {
    (apiMock.getSavings as jest.Mock).mockResolvedValue({ ...base, minutes_saved: 210, items_imported: 50, sales_imported: 30 });
    const screen = render(<SavingsCard />);
    expect(await screen.findByText('This month Resqlo saved you about 3.5 hrs')).toBeTruthy();
    expect(screen.getByText('· 50 items imported for you')).toBeTruthy();
  });

  it('renders nothing for a new user or on error', async () => {
    (apiMock.getSavings as jest.Mock).mockResolvedValueOnce(base);
    const empty = render(<SavingsCard />);
    await waitFor(() => expect(apiMock.getSavings).toHaveBeenCalled());
    expect(empty.toJSON()).toBeNull();
    (apiMock.getSavings as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const failed = render(<SavingsCard />);
    await waitFor(() => expect(apiMock.getSavings).toHaveBeenCalledTimes(2));
    expect(failed.toJSON()).toBeNull();
  });
});
