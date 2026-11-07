import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { trialLabel } from '../services/purchases';
import { isProRequired } from '../components/ProUpsell';
import { EbayCompsCard } from '../components/EbayCompsCard';
import * as api from '../services/api';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, replace: jest.fn() }) }));
jest.mock('../services/api', () => ({ getItemEbayComps: jest.fn(), searchEbayComps: jest.fn() }));

describe('trialLabel', () => {
  it('labels free intro offers only', () => {
    expect(trialLabel({ price: 0, periodUnit: 'DAY', periodNumberOfUnits: 7 })).toBe('7-day free trial');
    expect(trialLabel({ price: 0, periodUnit: 'WEEK', periodNumberOfUnits: 1 })).toBe('1-week free trial');
    expect(trialLabel({ price: 4.99, periodUnit: 'MONTH', periodNumberOfUnits: 1 })).toBeUndefined();
    expect(trialLabel(null)).toBeUndefined();
    expect(trialLabel({ price: 0, periodUnit: 'FORTNIGHT', periodNumberOfUnits: 1 })).toBeUndefined();
  });
});

describe('Pro upsell for market pricing', () => {
  it('detects pro_required errors', () => {
    expect(isProRequired({ detail: { error: 'pro_required' } })).toBe(true);
    expect(isProRequired(new Error('offline'))).toBe(false);
  });

  it('shows the upsell instead of an error when comps are Pro-only', async () => {
    (api.getItemEbayComps as jest.Mock).mockRejectedValueOnce({ detail: { error: 'pro_required', message: 'Pro' } });
    const screen = render(<EbayCompsCard itemId="i1" />);
    fireEvent.press(screen.getByTestId('ebay-comps-button'));
    await screen.findByTestId('ebay-comps-upsell');
    fireEvent.press(screen.getByText('See Pro'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/settings/subscription');
  });
});
