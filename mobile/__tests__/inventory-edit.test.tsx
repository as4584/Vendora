import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import EditItemScreen from '../app/(tabs)/inventory/edit';
import * as ImagePicker from 'expo-image-picker';
import * as api from '../services/api';

const mockBack = jest.fn();
const mockSearchParams = jest.fn((): { id?: string } => ({ id: 'item-1' }));
const mockRequestCameraPermission = jest.fn();
let mockCameraPermission: { granted: boolean } | null = { granted: true };

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => mockSearchParams(),
}));

jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'images' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

jest.mock('expo-camera', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    useCameraPermissions: () => [mockCameraPermission, mockRequestCameraPermission],
    CameraView: (props: unknown) =>
      ReactModule.createElement(View, { ...props, testID: 'edit-camera-view' }),
  };
});

jest.mock('../services/api', () => ({
  getItem: jest.fn(),
  updateItem: jest.fn(),
  uploadItemPhotos: jest.fn(),
}));

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedApi = api as jest.Mocked<typeof api>;

function item(overrides: Partial<api.InventoryItem> = {}): api.InventoryItem {
  return {
    id: 'item-1',
    user_id: 'user-1',
    name: 'Loaded Item',
    category: 'electronics',
    sku: 'SKU-1',
    upc: '123',
    size: 'M',
    color: 'black',
    condition: 'new',
    serial_number: null,
    custom_attributes: { brand: 'Acme' },
    buy_price: '10.00',
    expected_sell_price: '20.00',
    actual_sell_price: '18.00',
    platform: 'Vendora',
    status: 'in_stock',
    photo_front_url: 'https://example.com/front.jpg',
    photo_back_url: 'https://example.com/back.jpg',
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

async function renderLoaded(overrides: Partial<api.InventoryItem> = {}) {
  mockedApi.getItem.mockResolvedValueOnce(item(overrides));
  const screen = render(<EditItemScreen />);
  await screen.findByText('Edit Item');
  return screen;
}

describe('edit inventory screen', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams.mockReturnValue({ id: 'item-1' });
    mockCameraPermission = { granted: true };
    mockRequestCameraPermission.mockResolvedValue({ granted: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.requestCameraPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as any);
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as any);
    mockedApi.updateItem.mockResolvedValue(item());
    mockedApi.uploadItemPhotos.mockResolvedValue(item());
  });

  afterEach(() => alertSpy.mockRestore());

  it('loads existing fields and supports navigating back', async () => {
    const screen = await renderLoaded();
    expect(mockedApi.getItem).toHaveBeenCalledWith('item-1');
    expect(screen.getByLabelText('Item Name').props.value).toBe('Loaded Item');
    expect(screen.getByLabelText('Brand').props.value).toBe('Acme');
    expect(screen.getByLabelText('UPC or Barcode').props.value).toBe('123');
    fireEvent.press(screen.getByText(/Back/));
    expect(mockBack).toHaveBeenCalled();
  });

  it('exits safely for a missing item ID or a failed item request', async () => {
    mockSearchParams.mockReturnValue({});
    const missingScreen = render(<EditItemScreen />);
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Error', 'This item link is missing an inventory ID.'),
    );
    expect(mockBack).toHaveBeenCalled();
    await missingScreen.findByText('Edit Item');
    fireEvent.press(missingScreen.getByText(/Save Changes/));
    expect(mockedApi.updateItem).not.toHaveBeenCalled();
    missingScreen.unmount();

    jest.clearAllMocks();
    mockSearchParams.mockReturnValue({ id: 'item-1' });
    mockedApi.getItem.mockRejectedValueOnce(new Error('Item unavailable'));
    render(<EditItemScreen />);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'Item unavailable'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('validates and saves a regular item with edited fields', async () => {
    const screen = await renderLoaded({ photo_front_url: null, photo_back_url: null });
    fireEvent.changeText(screen.getByLabelText('Item Name'), '   ');
    fireEvent.press(screen.getByText(/Save Changes/));
    expect(alertSpy).toHaveBeenCalledWith('Required', 'Item name is required.');

    fireEvent.changeText(screen.getByLabelText('Item Name'), '  Updated Item  ');
    fireEvent.changeText(screen.getByLabelText('Brand'), '  Updated Brand  ');
    fireEvent.changeText(screen.getByLabelText('Category'), 'electronics');
    fireEvent.changeText(screen.getByLabelText('SKU'), ' NEW-SKU ');
    fireEvent.changeText(screen.getByLabelText('UPC or Barcode'), ' 999 ');
    fireEvent.changeText(screen.getByLabelText('Size'), ' L ');
    fireEvent.changeText(screen.getByLabelText('Color'), ' blue ');
    fireEvent.changeText(screen.getByLabelText('Condition'), ' used ');
    fireEvent.changeText(screen.getByLabelText('Buy Price'), ' 11 ');
    fireEvent.changeText(screen.getByLabelText('Expected Sell Price'), ' 22 ');
    fireEvent.changeText(screen.getByLabelText('Actual Sell Price'), ' 20 ');
    fireEvent.changeText(screen.getByLabelText('Platform'), ' eBay ');
    fireEvent.press(screen.getByLabelText('Increase quantity'));
    fireEvent.press(screen.getByLabelText('Decrease quantity'));
    fireEvent.press(screen.getByText(/Save Changes/));

    await waitFor(() => expect(mockedApi.updateItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateItem).toHaveBeenCalledWith('item-1', {
      name: 'Updated Item',
      category: 'electronics',
      sku: 'NEW-SKU',
      upc: '999',
      size: 'L',
      color: 'blue',
      condition: 'used',
      buy_price: '11',
      expected_sell_price: '22',
      actual_sell_price: '20',
      platform: 'eBay',
      quantity: 2,
      custom_attributes: { brand: 'Updated Brand' },
    });
    const actions = alertSpy.mock.calls.at(-1)?.[2];
    actions[0].onPress();
    expect(mockBack).toHaveBeenCalled();
  });

  it('edits clothing variants and derives total quantity', async () => {
    const screen = await renderLoaded({
      category: 'clothing',
      custom_attributes: { variants: [{ size: 'M', quantity: 1 }] },
    });
    fireEvent.press(screen.getByLabelText('Add Size'));
    fireEvent.changeText(screen.getByLabelText('New Size'), 'M');
    fireEvent.press(screen.getByLabelText('Add Size'));
    expect(alertSpy).toHaveBeenCalledWith('Duplicate', 'That size is already listed.');
    fireEvent.changeText(screen.getByLabelText('New Size'), 'L');
    fireEvent(screen.getByLabelText('New Size'), 'submitEditing');
    fireEvent.press(screen.getByLabelText('Increase quantity for M'));
    fireEvent.press(screen.getByLabelText('Decrease quantity for L'));
    fireEvent.press(screen.getByLabelText('Remove size L'));
    fireEvent.press(screen.getByText(/Save Changes/));
    await waitFor(() => expect(mockedApi.updateItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({
        quantity: 2,
        custom_attributes: { variants: [{ size: 'M', quantity: 2 }] },
      }),
    );
  });

  it('uploads only changed photos and scans a replacement barcode', async () => {
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'new-front', uri: 'front-uri' }],
    } as any);
    const screen = await renderLoaded();
    fireEvent.press(screen.getByLabelText('Edit front photo'));
    const photoActions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => photoActions[1].onPress());

    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await screen.findByTestId('edit-camera-view');
    const Modal = require('react-native').Modal;
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await screen.findByTestId('edit-camera-view');
    fireEvent.press(screen.getByText(/Cancel/));
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    const camera = await screen.findByTestId('edit-camera-view');
    act(() => {
      camera.props.onBarcodeScanned({ data: 'new-upc' });
      camera.props.onBarcodeScanned({ data: 'duplicate-upc' });
    });
    expect(screen.getByLabelText('UPC or Barcode').props.value).toBe('new-upc');

    fireEvent.press(screen.getByText(/Save Changes/));
    await waitFor(() =>
      expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
        'item-1',
        'data:image/jpeg;base64,new-front',
        undefined,
      ),
    );
  });

  it('updates a back photo from the camera and handles camera permission denial', async () => {
    picker.launchCameraAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'back-bytes', uri: 'back-uri' }],
    } as any);
    const screen = await renderLoaded();
    fireEvent.press(screen.getByLabelText('Edit back photo'));
    let actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[0].onPress());
    fireEvent.press(screen.getByText(/Save Changes/));
    await waitFor(() =>
      expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
        'item-1',
        undefined,
        'data:image/jpeg;base64,back-bytes',
      ),
    );

    picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);
    fireEvent.press(screen.getByLabelText('Edit back photo'));
    actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[0].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Permission Required',
      'Allow camera access to take item photos.',
    );
  });

  it('updates a front photo from the camera', async () => {
    picker.launchCameraAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'camera-front' }],
    } as any);
    const screen = await renderLoaded();
    fireEvent.press(screen.getByLabelText('Edit front photo'));
    const actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[0].onPress());
    fireEvent.press(screen.getByText(/Save Changes/));
    await waitFor(() =>
      expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
        'item-1',
        'camera-front',
        undefined,
      ),
    );
  });

  it('uses the direct back-photo library picker on web', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'blob:back' }],
    } as any);
    try {
      const screen = await renderLoaded();
      fireEvent.press(screen.getByLabelText('Edit back photo'));
      await waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalled());
      fireEvent.press(screen.getByText(/Save Changes/));
      await waitFor(() =>
        expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
          'item-1',
          undefined,
          'blob:back',
        ),
      );
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('handles photo, camera, and save failures', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);
    mockCameraPermission = null;
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: false });
    const screen = await renderLoaded();
    fireEvent.press(screen.getByLabelText('Edit front photo'));
    let actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[1].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Permission Required',
      'Allow photo access to attach item photos.',
    );

    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Permission Required',
        'Allow camera access to scan barcodes.',
      ),
    );

    mockedApi.updateItem.mockRejectedValueOnce(new Error('Save unavailable'));
    fireEvent.press(screen.getByText(/Save Changes/));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'Save unavailable'));
  });
});
