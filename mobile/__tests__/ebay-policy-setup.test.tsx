/**
 * One-tap eBay business-policy setup: listing sheet recovery and settings card.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as api from '../services/api';
import { EbayListingCard } from '../components/EbayListingCard';
import {
  EbayPoliciesCard,
  EbayPolicySetup,
  isMissingPoliciesError,
  policySummary,
} from '../components/EbayPolicySetup';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(), removeItem: jest.fn() },
}));

jest.mock('../services/api', () => ({
  getEbayListing: jest.fn(),
  createEbayListing: jest.fn(),
  getEbayPolicies: jest.fn(),
  setupEbayPolicies: jest.fn(),
  getEbayTraffic: jest.fn(async () => ({ summary: null, price_hint: null, watchers: null })),
}));

const m = api as jest.Mocked<typeof api>;

const ITEM = {
  id: 'item-1', name: 'Jordan 1 Chicago', size: '10', condition: 'new', expected_sell_price: '250',
  custom_attributes: {},
} as unknown as api.InventoryItem;
const NOT_LISTED: api.EbayListing = {
  item_id: 'item-1', listed: false, status: null, offer_id: null, listing_id: null,
  url: null, price: null, quantity: null, sku: null,
};
const LIVE: api.EbayListing = { ...NOT_LISTED, listed: true, status: 'active', price: '250.00', quantity: 1 };
const MISSING = { detail: { error: 'ebay_policies_missing', message: 'Your eBay account has no return policy.' } };
const SETUP_OK: api.EbayPolicySetupResult = {
  opt_in: 'opted_in', marketplace_id: 'EBAY_US', ready: true,
  policies: { fulfillment: { id: 'F9', name: 'Resqlo default shipping', label: 'shipping', created: true } },
};

beforeEach(() => {
  jest.clearAllMocks();
  m.getEbayPolicies.mockReset();
  m.createEbayListing.mockReset();
  m.setupEbayPolicies.mockReset();
});

describe('helpers', () => {
  it('summarises defaults and toggles', () => {
    expect(policySummary(false, true).join(' ')).toMatch(/buyer pays \$12\.00.*30 days/);
    expect(policySummary(true, false).join(' ')).toMatch(/free to the buyer.*not accepted/);
    expect(isMissingPoliciesError(MISSING)).toBe(true);
    expect(isMissingPoliciesError({ detail: { error: 'other' } })).toBe(false);
    expect(isMissingPoliciesError(null)).toBe(false);
  });
});

describe('List on eBay sheet', () => {
  it('offers setup on missing policies and retries the listing', async () => {
    m.getEbayListing.mockResolvedValue(NOT_LISTED);
    m.createEbayListing.mockRejectedValueOnce(MISSING).mockResolvedValueOnce(LIVE);
    m.setupEbayPolicies.mockResolvedValue(SETUP_OK);
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByTestId('ebay-list-button'));
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(screen.getByTestId('ebay-policy-setup')).toBeTruthy();
    expect(screen.getByText('Set up selling policies for me')).toBeTruthy();
    fireEvent(screen.getByTestId('ebay-policy-free-shipping'), 'valueChange', true);
    fireEvent(screen.getByTestId('ebay-policy-accept-returns'), 'valueChange', false);
    expect(screen.getByText(/free to the buyer/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-policy-submit')); });
    expect(m.setupEbayPolicies).toHaveBeenCalledWith({ free_shipping: true, returns_accepted: false });
    await waitFor(() => expect(m.createEbayListing).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('ebay-listing-live')).toBeTruthy();
  });

  it('shows setup errors and does not retry', async () => {
    m.getEbayListing.mockResolvedValue(NOT_LISTED);
    m.createEbayListing.mockRejectedValue(MISSING);
    m.setupEbayPolicies.mockRejectedValue({ detail: { message: 'eBay is still turning on business policies. Try again shortly.' } });
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByTestId('ebay-list-button'));
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-policy-submit')); });
    expect(screen.getByTestId('ebay-policy-error').props.children).toMatch(/Try again/);
    expect(m.createEbayListing).toHaveBeenCalledTimes(1);
  });

  it('does not offer setup for other errors', async () => {
    m.getEbayListing.mockResolvedValue(NOT_LISTED);
    m.createEbayListing.mockRejectedValue({ detail: { error: 'ebay_error', message: 'Bad category' } });
    const screen = render(<EbayListingCard item={ITEM} available={1} />);
    fireEvent.press(await screen.findByTestId('ebay-list-button'));
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-submit')); });
    expect(screen.getByTestId('ebay-form-error').props.children).toBe('Bad category');
    expect(screen.queryByTestId('ebay-policy-setup')).toBeNull();
  });
});

describe('EbayPolicySetup', () => {
  it('falls back to a generic error message', async () => {
    m.setupEbayPolicies.mockRejectedValue({});
    const screen = render(<EbayPolicySetup />);
    await act(async () => { fireEvent.press(screen.getByTestId('ebay-policy-submit')); });
    expect(screen.getByTestId('ebay-policy-error').props.children).toMatch(/Could not set up/);
    expect(m.setupEbayPolicies).toHaveBeenCalledWith({ free_shipping: false, returns_accepted: true });
  });
});

describe('Settings eBay policies card', () => {
  it('renders nothing when eBay is not connected', () => {
    const screen = render(<EbayPoliciesCard connected={false} />);
    expect(screen.toJSON()).toBeNull();
    expect(m.getEbayPolicies).not.toHaveBeenCalled();
  });

  it('shows existing policies when ready', async () => {
    m.getEbayPolicies.mockResolvedValue({
      opted_in: true, marketplace_id: 'EBAY_US', ready: true, missing: [],
      policies: {
        fulfillment: { id: 'F1', name: 'My shipping', label: 'shipping' },
        payment: { id: 'P1', name: 'My payment', label: 'payment' },
        return: { id: 'R1', name: 'My returns', label: 'return' },
      },
    });
    const screen = render(<EbayPoliciesCard connected />);
    expect(await screen.findByTestId('ebay-policies-ready')).toBeTruthy();
    expect(screen.getByText('Shipping: My shipping')).toBeTruthy();
  });

  it('offers setup when missing and reloads after success', async () => {
    m.getEbayPolicies
      .mockResolvedValueOnce({
        opted_in: false, marketplace_id: 'EBAY_US', ready: false, missing: ['shipping', 'payment', 'return'],
        policies: { fulfillment: null, payment: null, return: null },
      })
      .mockResolvedValueOnce({
        opted_in: true, marketplace_id: 'EBAY_US', ready: true, missing: [],
        policies: { fulfillment: { id: 'F9', name: 'Resqlo default shipping', label: 'shipping' }, payment: null, return: null },
      });
    m.setupEbayPolicies.mockResolvedValue(SETUP_OK);
    const screen = render(<EbayPoliciesCard connected />);
    const submit = await screen.findByTestId('settings-ebay-policy-submit');
    await act(async () => { fireEvent.press(submit); });
    expect(await screen.findByTestId('ebay-policies-ready')).toBeTruthy();
    expect(m.getEbayPolicies).toHaveBeenCalledTimes(2);
  });

  it('shows a load error', async () => {
    m.getEbayPolicies.mockRejectedValue({ detail: { message: 'Reconnect eBay to let Resqlo manage your selling policies.' } });
    const screen = render(<EbayPoliciesCard connected />);
    expect((await screen.findByTestId('ebay-policies-load-error')).props.children).toMatch(/Reconnect/);
  });

  it('shows a generic load error', async () => {
    m.getEbayPolicies.mockRejectedValue({});
    const screen = render(<EbayPoliciesCard connected />);
    expect((await screen.findByTestId('ebay-policies-load-error')).props.children).toMatch(/Could not check/);
  });
});
