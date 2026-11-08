import React from 'react';
import { render } from '@testing-library/react-native';
import InventoryCard from '../components/InventoryCard';
import type { InventoryItem } from '../services/api';

const item = { id: 'local-item', name: 'Dunk Low', status: 'in_stock', quantity: 1, buy_price: '90', expected_sell_price: '150', custom_attributes: {} } as InventoryItem;

describe('seller condition tag', () => {
  it.each([
    [' DS ', 'DS · Deadstock'], ['vnds', 'VNDS · Very near deadstock'],
    ['new', 'New'], ['used', 'Pre-owned'], ['Box damaged', 'Box damaged'], ['constructor', 'constructor'],
  ])('shows the seller grade %s without inferring another grade', (condition, label) => {
    const screen = render(<InventoryCard item={{ ...item, condition }} onPress={jest.fn()} />);
    expect(screen.getByLabelText(`Condition: ${label}`)).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });
  it('does not invent a condition for ungraded inventory', () => {
    const screen = render(<InventoryCard item={{ ...item, condition: null }} onPress={jest.fn()} />);
    expect(screen.queryByLabelText(/^Condition:/)).toBeNull();
  });
});
