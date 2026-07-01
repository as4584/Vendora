import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AddItemScreen from '../app/(tabs)/inventory/add';
import * as ImagePicker from 'expo-image-picker';
import * as api from '../services/api';

const mockReplace = jest.fn();
const mockRequestCameraPermission = jest.fn();
let mockCameraPermission: { granted: boolean } | null = { granted: true };

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
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
      ReactModule.createElement(View, { ...props, testID: 'camera-view' }),
  };
});

jest.mock('../services/api', () => ({
  createItem: jest.fn(),
  uploadItemPhotos: jest.fn(),
}));

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedApi = api as jest.Mocked<typeof api>;

function enterRequired(screen: ReturnType<typeof render>, name = 'Jordan 1') {
  fireEvent.changeText(screen.getByLabelText('Item Name'), name);
}

describe('add inventory screen', () => {
  let alertSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCameraPermission = { granted: true };
    mockRequestCameraPermission.mockResolvedValue({ granted: true });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.requestCameraPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as any);
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as any);
    mockedApi.createItem.mockResolvedValue({ id: 'item-1' } as api.InventoryItem);
    mockedApi.uploadItemPhotos.mockResolvedValue({ id: 'item-1' } as api.InventoryItem);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('requires an item name before creating inventory', () => {
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByText('Add to Inventory'));
    expect(alertSpy).toHaveBeenCalledWith('Required', 'Item name is required.');
    expect(mockedApi.createItem).not.toHaveBeenCalled();
  });

  it('creates a regular item with normalized optional fields and quantity', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1700000000000);
    jest.spyOn(Math, 'random').mockReturnValueOnce(0.5);
    const screen = render(<AddItemScreen />);
    enterRequired(screen, '  Jordan 1  ');
    fireEvent.changeText(screen.getByLabelText('Category'), 'electronics');
    fireEvent.press(screen.getByLabelText('Generate SKU'));
    fireEvent.changeText(screen.getByLabelText('UPC or Barcode'), '012345');
    fireEvent.changeText(screen.getByLabelText('Size'), '10');
    fireEvent.changeText(screen.getByLabelText('Color'), 'red');
    fireEvent.changeText(screen.getByLabelText('Condition'), 'new');
    fireEvent.changeText(screen.getByLabelText('Buy Price'), '100');
    fireEvent.changeText(screen.getByLabelText('Expected Sell Price'), '180');
    fireEvent.changeText(screen.getByLabelText('Platform'), 'Vendora');
    fireEvent.changeText(screen.getByLabelText('Vendor or Supplier'), 'Nike');
    fireEvent.changeText(screen.getByLabelText('Notes'), '  boxed  ');
    fireEvent.press(screen.getByLabelText('Increase quantity'));
    fireEvent.press(screen.getByLabelText('Decrease quantity'));
    fireEvent.press(screen.getByText('Add to Inventory'));

    await waitFor(() => expect(mockedApi.createItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.createItem).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jordan 1',
        category: 'electronics',
        sku: expect.stringMatching(/^ELC-/),
        upc: '012345',
        size: '10',
        color: 'red',
        condition: 'new',
        buy_price: '100',
        expected_sell_price: '180',
        platform: 'Vendora',
        vendor_name: 'Nike',
        notes: 'boxed',
        quantity: 1,
        custom_attributes: undefined,
      }),
    );
    const successActions = alertSpy.mock.calls.at(-1)?.[2];
    successActions[0].onPress();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/inventory');
  });

  it('manages size variants, prevents duplicates, and derives total quantity', async () => {
    const screen = render(<AddItemScreen />);
    enterRequired(screen);
    fireEvent.changeText(screen.getByLabelText('Category'), 'Sneakers');
    fireEvent.press(screen.getByLabelText('Add Size'));
    expect(screen.queryByText('Total units: 1')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('New Size'), '10');
    fireEvent.press(screen.getByLabelText('Add Size'));
    fireEvent.changeText(screen.getByLabelText('New Size'), ' 10 ');
    fireEvent.press(screen.getByLabelText('Add Size'));
    expect(alertSpy).toHaveBeenCalledWith('Duplicate', 'That size is already listed.');

    fireEvent.changeText(screen.getByLabelText('New Size'), '11');
    fireEvent(screen.getByLabelText('New Size'), 'submitEditing');
    fireEvent.press(screen.getByLabelText('Increase quantity for 10'));
    fireEvent.press(screen.getByLabelText('Decrease quantity for 11'));
    fireEvent.press(screen.getByLabelText('Decrease quantity for 11'));
    expect(screen.getByText('Total units: 2')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Remove size 11'));
    fireEvent.press(screen.getByText('Add to Inventory'));

    await waitFor(() => expect(mockedApi.createItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.createItem).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 2,
        custom_attributes: { variants: [{ size: '10', quantity: 2 }] },
      }),
    );
  });

  it('selects front and back photos, uploads them, and keeps a created item if upload fails', async () => {
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'front-base64', uri: 'front-uri' }],
    } as any);
    picker.launchCameraAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'back-uri' }],
    } as any);
    mockedApi.uploadItemPhotos.mockRejectedValueOnce(new Error('storage unavailable'));
    const screen = render(<AddItemScreen />);

    fireEvent.press(screen.getByLabelText('Add front photo'));
    let options = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => options[1].onPress());
    fireEvent.press(screen.getByLabelText('Add back photo'));
    options = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => options[0].onPress());

    enterRequired(screen);
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() =>
      expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
        'item-1',
        'data:image/jpeg;base64,front-base64',
        'back-uri',
      ),
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Added'), 'Item saved to inventory!', expect.any(Array));
  });

  it('captures a front photo from the camera', async () => {
    picker.launchCameraAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'camera-front-uri' }],
    } as any);
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByLabelText('Add front photo'));
    const actions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => actions[0].onPress());
    enterRequired(screen);
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() =>
      expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
        'item-1',
        'camera-front-uri',
        null,
      ),
    );
  });

  it('reports photo permission denials', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByLabelText('Add front photo'));
    const options = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => options[1].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Permission Required',
      'Allow photo access to attach item photos.',
    );

    picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);
    fireEvent.press(screen.getByLabelText('Add back photo'));
    const cameraOptions = alertSpy.mock.calls.at(-1)?.[2];
    await act(async () => cameraOptions[0].onPress());
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Permission Required',
      'Allow camera access to take item photos.',
    );
  });

  it('uses the direct library picker for a back photo on web', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: null, uri: 'blob:back-photo' }],
    } as any);
    try {
      const screen = render(<AddItemScreen />);
      fireEvent.press(screen.getByLabelText('Add back photo'));
      await waitFor(() => expect(picker.launchImageLibraryAsync).toHaveBeenCalled());
      enterRequired(screen);
      fireEvent.press(screen.getByText('Add to Inventory'));
      await waitFor(() =>
        expect(mockedApi.uploadItemPhotos).toHaveBeenCalledWith(
          'item-1',
          null,
          'blob:back-photo',
        ),
      );
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('scans a barcode and handles camera permission refusal', async () => {
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await screen.findByTestId('camera-view');
    const Modal = require('react-native').Modal;
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await screen.findByTestId('camera-view');
    fireEvent.press(screen.getByText('Cancel'));
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    const camera = await screen.findByTestId('camera-view');
    act(() => {
      camera.props.onBarcodeScanned({ data: '998877' });
      camera.props.onBarcodeScanned({ data: 'duplicate-scan' });
    });
    expect(screen.getByLabelText('UPC or Barcode').props.value).toBe('998877');
    expect(alertSpy).toHaveBeenCalledWith('Barcode Scanned', 'UPC: 998877');
    expect(alertSpy).not.toHaveBeenCalledWith('Barcode Scanned', 'UPC: duplicate-scan');

    mockCameraPermission = null;
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: false });
    const deniedScreen = render(<AddItemScreen />);
    fireEvent.press(deniedScreen.getByLabelText('Scan barcode'));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Permission Required',
        'Allow camera access to scan barcodes.',
      ),
    );
  });

  it('shows tier-limit and general creation failures', async () => {
    mockedApi.createItem.mockRejectedValueOnce({
      detail: { error: 'tier_limit_reached', message: 'Upgrade now' },
    });
    const screen = render(<AddItemScreen />);
    enterRequired(screen);
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Tier Limit', 'Upgrade now'));

    mockedApi.createItem.mockRejectedValueOnce(new Error('Network offline'));
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'Network offline'));
  });
});
