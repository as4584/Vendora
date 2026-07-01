import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import ItemQuickSheet from '../app/(tabs)/inventory/components/ItemQuickSheet';
import * as api from '../services/api';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../services/api', () => ({
  updateItem: jest.fn(),
  deleteItem: jest.fn(),
}));

const mockedApi = api as jest.Mocked<typeof api>;

function item(overrides: Partial<api.InventoryItem> = {}): api.InventoryItem {
  return {
    id: 'item-1',
    user_id: 'user-1',
    name: 'Jordan 1',
    category: 'electronics',
    sku: 'SKU-1',
    upc: null,
    size: null,
    color: null,
    condition: 'new',
    serial_number: null,
    custom_attributes: { brand: 'Nike', warehouse_bin: 'A1' },
    buy_price: '100',
    expected_sell_price: '150',
    actual_sell_price: null,
    platform: null,
    status: 'in_stock',
    photo_front_url: null,
    photo_back_url: null,
    quantity: 2,
    vendor_name: null,
    notes: null,
    source: null,
    external_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    item: item(),
    visible: true,
    existingBrands: ['Nike', 'Adidas'],
    onClose: jest.fn(),
    onItemUpdated: jest.fn(),
    onItemDeleted: jest.fn(),
    ...overrides,
  };
}

describe('ItemQuickSheet', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockedApi.updateItem.mockImplementation(async (_id, payload) =>
      item({ name: payload.name ?? 'Jordan 1', quantity: payload.quantity ?? 2 }),
    );
    mockedApi.deleteItem.mockResolvedValue(undefined);
  });

  afterEach(() => alertSpy.mockRestore());

  it('renders nothing for an empty selection and animates closed state safely', () => {
    const screen = render(<ItemQuickSheet {...props({ item: null, visible: false })} />);
    expect(screen.toJSON()).toBeNull();
  });

  it('renders pricing, status, photo fallback, and all margin color bands', () => {
    const screen = render(<ItemQuickSheet {...props()} />);
    expect(screen.getByText('Jordan 1')).toBeTruthy();
    expect(screen.getByText('in stock')).toBeTruthy();
    expect(screen.getByText('+50.0%')).toBeTruthy();
    expect(screen.getByText('Brand: Nike')).toBeTruthy();

    screen.rerender(
      <ItemQuickSheet
        {...props({ item: item({ id: 'item-2', expected_sell_price: '120', status: 'unknown' }) })}
      />,
    );
    expect(screen.getByText('+20.0%')).toBeTruthy();

    screen.rerender(
      <ItemQuickSheet {...props({ item: item({ id: 'item-3', expected_sell_price: '110' }) })} />,
    );
    expect(screen.getByText('+10.0%')).toBeTruthy();

    screen.rerender(
      <ItemQuickSheet
        {...props({
          item: item({
            id: 'item-4',
            category: null,
            buy_price: '0',
            expected_sell_price: null,
            custom_attributes: { photo_front: 'data:image/png;base64,AA==' },
          }),
        })}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renames, rebrands, adjusts quantity, and saves a regular item', async () => {
    const callbacks = props();
    const screen = render(<ItemQuickSheet {...callbacks} />);
    fireEvent.press(screen.getByLabelText('Edit item name'));
    fireEvent.changeText(screen.getByLabelText('Item Name'), '  Updated Jordan  ');
    fireEvent(screen.getByLabelText('Item Name'), 'submitEditing');
    fireEvent.press(screen.getByLabelText('Edit brand'));
    fireEvent.changeText(screen.getByLabelText('Brand'), '  New Brand  ');
    fireEvent(screen.getByLabelText('Brand'), 'blur');
    fireEvent.press(screen.getByLabelText('Edit brand'));
    fireEvent(screen.getByLabelText('Brand'), 'submitEditing');
    fireEvent.press(screen.getByLabelText('Increase quantity'));
    fireEvent.press(screen.getByLabelText('Decrease quantity'));
    fireEvent.press(screen.getByText('Save Changes'));

    await waitFor(() => expect(mockedApi.updateItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateItem).toHaveBeenCalledWith('item-1', {
      name: 'Updated Jordan',
      quantity: 2,
      custom_attributes: {
        brand: 'New Brand',
        warehouse_bin: 'A1',
      },
    });
    expect(callbacks.onItemUpdated).toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalled();
  });

  it('rejects an empty name and can clear or choose a known brand', async () => {
    const screen = render(<ItemQuickSheet {...props()} />);
    fireEvent.press(screen.getByLabelText('Edit item name'));
    fireEvent.changeText(screen.getByLabelText('Item Name'), '   ');
    fireEvent.press(screen.getByText('Save Changes'));
    expect(alertSpy).toHaveBeenCalledWith('Required', 'Item name cannot be empty.');
    expect(mockedApi.updateItem).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByLabelText('Item Name'), 'Jordan 1');
    fireEvent(screen.getByLabelText('Item Name'), 'blur');
    fireEvent.press(screen.getByLabelText('Set brand to unbranded'));
    fireEvent.press(screen.getByText('Save Changes'));
    await waitFor(() => expect(mockedApi.updateItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ custom_attributes: { warehouse_bin: 'A1' } }),
    );

    const brandScreen = render(<ItemQuickSheet {...props({ item: item({ id: 'item-2' }) })} />);
    fireEvent.press(brandScreen.getByLabelText('Set brand to Adidas'));
    expect(brandScreen.getByText('Brand: Adidas')).toBeTruthy();
  });

  it('adds, adjusts, de-duplicates, removes, and saves clothing sizes', async () => {
    const clothing = item({
      category: 'Sneakers',
      custom_attributes: { brand: 'Nike', variants: [{ size: '10', quantity: 1 }] },
    });
    const screen = render(<ItemQuickSheet {...props({ item: clothing })} />);
    fireEvent.press(screen.getByLabelText('Add Size'));
    fireEvent.changeText(screen.getByLabelText('New Size'), '10');
    fireEvent.press(screen.getByLabelText('Add Size'));
    expect(alertSpy).toHaveBeenCalledWith('Duplicate', 'That size already exists.');

    fireEvent.changeText(screen.getByLabelText('New Size'), '11');
    fireEvent(screen.getByLabelText('New Size'), 'submitEditing');
    fireEvent.press(screen.getByLabelText('Increase quantity for 10'));
    fireEvent.press(screen.getByLabelText('Decrease quantity for 11'));
    fireEvent.press(screen.getByLabelText('Decrease quantity for 11'));
    fireEvent.press(screen.getByLabelText('Remove size 11'));
    fireEvent.press(screen.getByText('Save Changes'));

    await waitFor(() => expect(mockedApi.updateItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateItem).toHaveBeenCalledWith('item-1', {
      name: 'Jordan 1',
      custom_attributes: {
        brand: 'Nike',
        variants: [{ size: '10', quantity: 2 }],
      },
    });
  });

  it('renders an empty clothing state and opens the full edit route', () => {
    const callbacks = props({
      item: item({ category: 'clothing', custom_attributes: null }),
    });
    const screen = render(<ItemQuickSheet {...callbacks} />);
    expect(screen.getByText('No sizes added yet. Add sizes below.')).toBeTruthy();
    fireEvent.press(screen.getByText(/Full Edit/));
    expect(callbacks.onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/inventory/edit?id=item-1');
  });

  it('confirms deletion and reports delete failures', async () => {
    const callbacks = props();
    const screen = render(<ItemQuickSheet {...callbacks} />);
    fireEvent.press(screen.getByText('Delete'));
    let actions = alertSpy.mock.calls.at(-1)?.[2];
    expect(actions[0]).toEqual(expect.objectContaining({ text: 'Cancel', style: 'cancel' }));
    await act(async () => actions[1].onPress());
    expect(mockedApi.deleteItem).toHaveBeenCalledWith('item-1');
    expect(callbacks.onItemDeleted).toHaveBeenCalledWith('item-1');
    expect(callbacks.onClose).toHaveBeenCalled();

    mockedApi.deleteItem.mockRejectedValueOnce(new Error('Delete unavailable'));
    const failed = render(<ItemQuickSheet {...props({ item: item({ id: 'item-2' }) })} />);
    fireEvent.press(failed.getByText('Delete'));
    actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[1].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith('Error', 'Delete unavailable');
  });

  it('reports update failures and restores the save action', async () => {
    mockedApi.updateItem.mockRejectedValueOnce(new Error('Save unavailable'));
    const screen = render(<ItemQuickSheet {...props()} />);
    fireEvent.press(screen.getByText('Save Changes'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'Save unavailable'));
    expect(screen.getByText('Save Changes')).toBeTruthy();
  });
});
