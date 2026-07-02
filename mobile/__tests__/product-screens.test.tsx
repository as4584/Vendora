import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import * as api from '../services/api';
import SubscriptionScreen from '../app/(tabs)/settings/subscription';
import AnalyticsScreen from '../app/(tabs)/settings/analytics';
import SupportScreen from '../app/(tabs)/settings/support';
import SellerProfileScreen from '../app/seller/[id]';

const mockRefreshUser = jest.fn(async () => undefined);
let mockCurrentUser: any = { id: 'user-1', email: 'seller@test.com', subscription_tier: 'free', is_partner: false };
let mockSellerId: string | undefined = 'seller-1';

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: mockSellerId }), useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));
jest.mock('../context/auth', () => ({ useAuth: () => ({ user: mockCurrentUser, refreshUser: mockRefreshUser }) }));
jest.mock('../services/api', () => ({
  getSubscriptionStatus: jest.fn(), createSubscriptionCheckout: jest.fn(), createBillingPortal: jest.fn(),
  getAdvancedAnalytics: jest.fn(), submitSupportRequest: jest.fn(), getSellerProfile: jest.fn(),
}));

const subscription = { tier: 'free', is_partner: false, status: 'none', current_period_end: null, managed_billing: false };
const analytics = { period_days: 30, revenue: '100', net: '80', average_order_value: '50', sell_through_rate: '25', daily: [{ date: '2026-07-01', revenue: '100', net: '80', transactions: 2 }, { date: '2026-07-02', revenue: '120', net: '90', transactions: 1 }], categories: [{ category: 'Shoes', revenue: '100', units_sold: 2 }] };
const seller = { seller: { id: 'seller-1', business_name: 'Test Store', is_partner: true, verified: true, member_since: '2025-01-01T00:00:00Z' }, stats: { total_items: 4, items_sold: 2, total_transactions: 3 }, listings: [{ id: 'item-1', name: 'Sneaker', category: 'Shoes', size: '10', color: 'Red', condition: 'New', price: '120', status: 'in_stock' }], disclaimer: 'Marketplace disclaimer.' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockCurrentUser = { id: 'user-1', email: 'seller@test.com', subscription_tier: 'free', is_partner: false };
  mockSellerId = 'seller-1';
  (api.getSubscriptionStatus as jest.Mock).mockResolvedValue(subscription);
  (api.getAdvancedAnalytics as jest.Mock).mockResolvedValue(analytics);
  (api.getSellerProfile as jest.Mock).mockResolvedValue(seller);
});

afterEach(() => jest.restoreAllMocks());

describe('subscription product', () => {
  it('shows loading then opens Pro and Partner checkout', async () => {
    let resolveStatus!: (value: any) => void;
    (api.getSubscriptionStatus as jest.Mock).mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    const screen = render(<SubscriptionScreen />);
    expect(screen.getByTestId('subscription-loading')).toBeTruthy();
    resolveStatus(subscription);
    await screen.findByTestId('subscription-content');
    (api.createSubscriptionCheckout as jest.Mock).mockResolvedValue({ checkout_url: 'https://checkout', session_id: 'cs' });
    fireEvent.press(screen.getByText('Upgrade to Pro'));
    await waitFor(() => expect(api.createSubscriptionCheckout).toHaveBeenCalledWith('pro'));
    await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://checkout'));
    fireEvent.press(screen.getByText('Add Partner'));
    await waitFor(() => expect(api.createSubscriptionCheckout).toHaveBeenCalledWith('partner'));
  });

  it('renders active partner billing and opens portal', async () => {
    (api.getSubscriptionStatus as jest.Mock).mockResolvedValue({ tier: 'pro', is_partner: true, status: 'active', current_period_end: '2026-08-01T00:00:00Z', managed_billing: true });
    (api.createBillingPortal as jest.Mock).mockResolvedValue({ portal_url: 'https://portal' });
    const screen = render(<SubscriptionScreen />);
    await screen.findByText('PARTNER');
    expect(screen.getAllByText('Active')).toHaveLength(2);
    fireEvent.press(screen.getByText('Manage Billing'));
    await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://portal'));
  });

  it('reports load, checkout, and portal errors', async () => {
    (api.getSubscriptionStatus as jest.Mock).mockRejectedValueOnce(new Error('load failed'));
    const failed = render(<SubscriptionScreen />);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Billing unavailable', 'load failed'));
    failed.unmount();
    (api.getSubscriptionStatus as jest.Mock).mockResolvedValue(subscription);
    (api.createSubscriptionCheckout as jest.Mock).mockRejectedValue(new Error('checkout failed'));
    const checkout = render(<SubscriptionScreen />); await checkout.findByText('Upgrade to Pro'); fireEvent.press(checkout.getByText('Upgrade to Pro'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Upgrade unavailable', 'checkout failed'));
    checkout.unmount();
    (api.getSubscriptionStatus as jest.Mock).mockResolvedValue({ ...subscription, managed_billing: true });
    (api.createBillingPortal as jest.Mock).mockRejectedValue(new Error('portal failed'));
    const portal = render(<SubscriptionScreen />); await portal.findByText('Manage Billing'); fireEvent.press(portal.getByText('Manage Billing'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Billing unavailable', 'portal failed'));
  });
});

describe('analytics product', () => {
  it('shows loading, metrics, chart, and categories', async () => {
    let resolve!: (value: any) => void;
    (api.getAdvancedAnalytics as jest.Mock).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const screen = render(<AnalyticsScreen />); expect(screen.getByTestId('analytics-loading')).toBeTruthy(); resolve(analytics);
    await screen.findByTestId('analytics-content'); expect(screen.getByText('Shoes')).toBeTruthy(); expect(screen.getByText('Revenue over time')).toBeTruthy(); expect(screen.getByText('100%')).toBeTruthy();
  });
  it('shows empty categories and API errors', async () => {
    (api.getAdvancedAnalytics as jest.Mock).mockResolvedValueOnce({ ...analytics, revenue: '0', categories: [], daily: [] });
    const empty = render(<AnalyticsScreen />); await empty.findByText('Complete sales to populate category insights.'); empty.unmount();
    (api.getAdvancedAnalytics as jest.Mock).mockRejectedValueOnce(new Error('Pro required'));
    const failed = render(<AnalyticsScreen />); await failed.findByTestId('analytics-error'); expect(failed.getByText('Pro required')).toBeTruthy();
  });
});

describe('support product', () => {
  it('validates and submits a standard request', async () => {
    (api.submitSupportRequest as jest.Mock).mockResolvedValue({ id: '12345678-abcd', status: 'open', priority: 'standard', email_queued: true });
    const screen = render(<SupportScreen />); fireEvent.press(screen.getByText('Submit Request'));
    expect(Alert.alert).toHaveBeenCalledWith('More detail needed', expect.any(String));
    fireEvent.changeText(screen.getByLabelText('Support subject'), 'Need help'); fireEvent.changeText(screen.getByLabelText('Support message'), 'Something is broken badly.'); fireEvent.press(screen.getByText('Submit Request'));
    await waitFor(() => expect(api.submitSupportRequest).toHaveBeenCalledWith('Need help', 'Something is broken badly.'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Request received', 'Standard ticket 12345678 is open.'));
  });
  it('shows priority service and submission errors', async () => {
    mockCurrentUser = { ...mockCurrentUser, is_partner: true };
    (api.submitSupportRequest as jest.Mock).mockRejectedValue(new Error('offline'));
    const screen = render(<SupportScreen />); expect(screen.getByText('PRIORITY')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Support subject'), 'Need help'); fireEvent.changeText(screen.getByLabelText('Support message'), 'Something is broken badly.'); fireEvent.press(screen.getByText('Submit Request'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Request failed', 'offline'));
  });
});

describe('public seller product', () => {
  it('shows loading and a verified storefront', async () => {
    let resolve!: (value: any) => void; (api.getSellerProfile as jest.Mock).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const screen = render(<SellerProfileScreen />); expect(screen.getByTestId('seller-loading')).toBeTruthy(); resolve(seller);
    await screen.findByTestId('seller-content'); expect(screen.getByText('✓ VERIFIED')).toBeTruthy(); expect(screen.getByText('$120.00')).toBeTruthy();
  });
  it('renders empty optional storefront fields and errors', async () => {
    (api.getSellerProfile as jest.Mock).mockResolvedValueOnce({ ...seller, seller: { ...seller.seller, verified: false, member_since: null }, listings: [{ ...seller.listings[0], price: null, category: null, size: null, color: null, condition: null, status: 'listed' }] });
    const sparse = render(<SellerProfileScreen />); await sparse.findByText('Ask seller'); expect(sparse.getByText('Listing details available from seller')).toBeTruthy(); sparse.unmount();
    (api.getSellerProfile as jest.Mock).mockResolvedValueOnce({ ...seller, listings: [] });
    const empty = render(<SellerProfileScreen />); await empty.findByText('No public listings right now.'); empty.unmount();
    (api.getSellerProfile as jest.Mock).mockRejectedValueOnce(new Error('Not found'));
    const failed = render(<SellerProfileScreen />); await failed.findByTestId('seller-error'); expect(failed.getByText('Not found')).toBeTruthy();
  });
  it('does not request without a seller id', () => { mockSellerId = undefined; render(<SellerProfileScreen />); expect(api.getSellerProfile).not.toHaveBeenCalled(); });
});
