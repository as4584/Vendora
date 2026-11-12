import React from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AddItemScreen from '../app/(tabs)/inventory/add';
import * as ImagePicker from 'expo-image-picker';
import * as api from '../services/api';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRequestCameraPermission = jest.fn();
let mockCameraPermission: { granted: boolean } | null = { granted: true };
const mockTakePicture = jest.fn(async () => ({ uri: 'file:///label.jpg' }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
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
    CameraView: ReactModule.forwardRef((props: object, ref: unknown) => {
      ReactModule.useImperativeHandle(ref, () => ({ takePictureAsync: mockTakePicture }));
      return ReactModule.createElement(View, { ...props, testID: 'camera-view' });
    }),
  };
});

jest.mock('../services/api', () => ({
  createItem: jest.fn(),
  uploadItemPhotos: jest.fn(),
}));

const mockResolveScan = jest.fn();
const mockRememberScan = jest.fn();
const mockReadLabel = jest.fn();
let mockLabelReader = true;
let mockLive = false;
let mockLiveResult: Record<string, string> = {};
jest.mock('../components/LiveBoxScanner', () => {
  const R = require('react');
  const { Pressable } = require('react-native');
  const btn = (testID: string, onPress: () => void) => R.createElement(Pressable, { key: testID, testID, onPress });
  return {
    LiveBoxScanner: (props: any) =>
      R.createElement(R.Fragment, null, [
        btn('mock-live-finish', () => props.onFinish(mockLiveResult)),
        btn('mock-live-cancel', props.onCancel),
        btn('mock-live-unavailable', () => props.onUnavailable('Live scanning stopped.')),
      ]),
  };
});
jest.mock('../services/smartScan', () => ({
  isLiveScanAvailable: async () => mockLive,
  mergeFields: (remembered: object, read: object) => ({ ...read, ...remembered }),
  resolveScan: (...a: unknown[]) => mockResolveScan(...a),
  rememberScan: (...a: unknown[]) => mockRememberScan(...a),
  readLabel: (...a: unknown[]) => mockReadLabel(...a),
  syncScanMemory: jest.fn(async () => 0),
  backfillScanMemoryOnce: jest.fn(async () => true),
  isLabelReaderAvailable: () => mockLabelReader,
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
    mockLabelReader = true;
    mockLive = false;
    mockLiveResult = {};
    mockResolveScan.mockResolvedValue({ barcode: 'x', match: null, fields: {}, times_seen: 0 });
    mockRememberScan.mockResolvedValue(undefined);
    mockReadLabel.mockResolvedValue({});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('syncs scan memory, then runs the one-time inventory backfill on mount', async () => {
    const smartScan = require('../services/smartScan');
    render(<AddItemScreen />);
    await waitFor(() => expect(smartScan.backfillScanMemoryOnce).toHaveBeenCalled());
    expect(smartScan.syncScanMemory).toHaveBeenCalled();
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
    fireEvent(screen.UNSAFE_getAllByType(Modal)[0], 'requestClose');
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    await screen.findByTestId('camera-view');
    fireEvent.press(screen.getByText('Cancel'));
    fireEvent.press(screen.getByLabelText('Scan barcode'));
    const camera = await screen.findByTestId('camera-view');
    mockLabelReader = false;
    await act(async () => {
      camera.props.onBarcodeScanned({ data: '998877' });
      camera.props.onBarcodeScanned({ data: 'duplicate-scan' });
    });
    expect(screen.getByLabelText('UPC or Barcode').props.value).toBe('998877');
    expect(mockResolveScan).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Type the details once/);

    mockCameraPermission = null;
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: false, canAskAgain: true });
    const deniedScreen = render(<AddItemScreen />);
    fireEvent.press(deniedScreen.getByLabelText('Scan barcode'));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenLastCalledWith(
        'Camera access needed',
        'Allow camera access to scan barcodes and box labels.',
        [{ text: 'OK' }],
      ),
    );

    // Permanently denied: offer a way to Settings.
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: false, canAskAgain: false });
    fireEvent.press(deniedScreen.getByLabelText('Scan barcode'));
    await waitFor(() => expect(alertSpy.mock.calls.at(-1)?.[2]).toHaveLength(2));
    const buttons = alertSpy.mock.calls.at(-1)?.[2];
    buttons.find((b: { text: string }) => b.text === 'Open Settings').onPress();
    expect(openSettings).toHaveBeenCalled();
  });

  it('fills the form from scan memory and remembers the save', async () => {
    mockResolveScan.mockResolvedValueOnce({
      barcode: '195866137738',
      match: 'memory',
      times_seen: 3,
      fields: { name: 'Nike Dunk Low Panda', sku: 'DD1391-100', style_code: 'DD1391-100', color: 'White/Black', buy_price: '110.00' },
    });
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByTestId('smart-scan-button'));
    const camera = await screen.findByTestId('camera-view');
    await act(async () => {
      await camera.props.onBarcodeScanned({ data: '195866137738' });
    });
    expect(screen.getByLabelText('Item Name').props.value).toBe('Nike Dunk Low Panda');
    expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/seen 3 times/);

    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() => expect(mockRememberScan).toHaveBeenCalledWith('195866137738', expect.objectContaining({
      name: 'Nike Dunk Low Panda', style_code: 'DD1391-100', buy_price: '110.00',
    })));
  });

  it('reads the box label for a new barcode without overwriting typed fields', async () => {
    mockReadLabel.mockResolvedValueOnce({ name: 'Label Name', style_code: 'FV5029-006', sku: 'FV5029-006', color: 'Black/Cement' });
    const screen = render(<AddItemScreen />);
    fireEvent.changeText(screen.getByLabelText('Item Name'), 'My own name');
    fireEvent.press(screen.getByTestId('smart-scan-button'));
    const camera = await screen.findByTestId('camera-view');
    await act(async () => {
      await camera.props.onBarcodeScanned({ data: '197862948123' });
    });
    expect(screen.getByTestId('smart-scan-label-step')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Read label'));
    });
    await waitFor(() => expect(mockReadLabel).toHaveBeenCalledWith('file:///label.jpg'));
    expect(mockResolveScan).toHaveBeenLastCalledWith('197862948123', 'FV5029-006');
    expect(screen.getByLabelText('Item Name').props.value).toBe('My own name');
    expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Read from the box label/);
  });

  it('scans a card or slab straight to reading it, with no barcode step', async () => {
    mockReadLabel.mockResolvedValueOnce({ name: '2023 Pokemon Charizard ex #199', condition: 'PSA 10', sku: 'PSA-87654321', category: 'collectibles' });
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByTestId('card-scan-button'));
    expect(await screen.findByText('Scan a card')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Read card'));
    });
    await waitFor(() => expect(mockReadLabel).toHaveBeenCalledWith('file:///label.jpg'));
    expect(mockResolveScan).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Item Name').props.value).toBe('2023 Pokemon Charizard ex #199');
    expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Read from the card/);
  });

  it('explains when a card could not be read', async () => {
    mockReadLabel.mockResolvedValueOnce({ category: 'collectibles' });
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByTestId('card-scan-button'));
    await screen.findByText('Read card');
    await act(async () => {
      fireEvent.press(screen.getByText('Read card'));
    });
    await waitFor(() => expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Couldn't read that card/));
  });

  it('lets the seller skip the label and type it', async () => {
    const screen = render(<AddItemScreen />);
    fireEvent.press(screen.getByTestId('smart-scan-button'));
    const camera = await screen.findByTestId('camera-view');
    await act(async () => {
      await camera.props.onBarcodeScanned({ data: '12345678' });
    });
    fireEvent.press(screen.getByText('Type it myself'));
    expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/remember it next time/);
  });

  it('shows tier-limit and general creation failures', async () => {
    mockedApi.createItem.mockRejectedValueOnce({
      detail: { error: 'tier_limit_reached', message: 'Upgrade now' },
    });
    const screen = render(<AddItemScreen />);
    enterRequired(screen);
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("You've hit the free limit", 'Upgrade now', expect.any(Array)));
    const buttons = alertSpy.mock.calls.at(-1)[2];
    buttons.find((b: any) => b.text === 'See Pro').onPress();
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/settings/subscription');

    mockedApi.createItem.mockRejectedValueOnce(new Error('Network offline'));
    fireEvent.press(screen.getByText('Add to Inventory'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'Network offline'));
  });

  describe('live box scanner', () => {
    async function openLive() {
      mockLive = true;
      const screen = render(<AddItemScreen />);
      // Let the availability check resolve.
      await act(async () => undefined);
      fireEvent.press(screen.getByTestId('smart-scan-button'));
      await screen.findByTestId('mock-live-finish');
      return screen;
    }

    it('uses the live scanner when supported and fills from what it read', async () => {
      mockLiveResult = { barcode: '197862948123', name: 'Jordan 4 Retro', style_code: 'FV5029-006', sku: 'FV5029-006', size: '10' };
      const screen = await openLive();
      expect(screen.queryByTestId('camera-view')).toBeNull();
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(mockResolveScan).toHaveBeenCalledWith('197862948123', 'FV5029-006');
      expect(screen.getByLabelText('UPC or Barcode').props.value).toBe('197862948123');
      expect(screen.getByLabelText('Item Name').props.value).toBe('Jordan 4 Retro');
      expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Read live/);
    });

    it('memory wins over the live read and typed fields are never overwritten', async () => {
      mockResolveScan.mockResolvedValueOnce({
        barcode: '1', match: 'memory', times_seen: 2,
        fields: { name: 'Remembered Name', color: 'Bred', buy_price: '150.00' },
      });
      mockLiveResult = { barcode: '1', name: 'Read Name', color: 'Black/Red', sku: 'X1' };
      mockLive = true;
      const screen = render(<AddItemScreen />);
      await act(async () => undefined);
      fireEvent.changeText(screen.getByLabelText('SKU'), 'MY-SKU');
      fireEvent.press(screen.getByTestId('smart-scan-button'));
      await screen.findByTestId('mock-live-finish');
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(screen.getByLabelText('Item Name').props.value).toBe('Remembered Name');
      expect(screen.getByLabelText('Color').props.value).toBe('Bred');
      expect(screen.getByLabelText('SKU').props.value).toBe('MY-SKU');
      expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/scan memory/);
    });

    it('takes the box size over a style-family match', async () => {
      mockResolveScan.mockResolvedValueOnce({
        barcode: '2', match: 'style', times_seen: 1, fields: { name: 'Family Name', size: '9' },
      });
      mockLiveResult = { barcode: '2', style_code: 'DD1391-100', size: '11', color: 'White/Black' };
      const screen = await openLive();
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(screen.getByLabelText('Item Name').props.value).toBe('Family Name');
      expect(screen.getByLabelText('Color').props.value).toBe('White/Black');
    });

    it('still applies the read when memory lookup fails, and handles empty reads', async () => {
      mockResolveScan.mockRejectedValueOnce(new Error('offline'));
      mockLiveResult = { barcode: '3', name: 'Only Read' };
      let screen = await openLive();
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(screen.getByLabelText('Item Name').props.value).toBe('Only Read');

      mockLiveResult = {};
      screen = await openLive();
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Nothing was read/);
    });

    it('reads label text without a barcode', async () => {
      mockLiveResult = { name: 'No Barcode Shoe' };
      const screen = await openLive();
      await act(async () => {
        fireEvent.press(screen.getByTestId('mock-live-finish'));
      });
      expect(mockResolveScan).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Item Name').props.value).toBe('No Barcode Shoe');
    });

    it('cancels, and falls back to tap-to-read when the live scanner is unavailable', async () => {
      const screen = await openLive();
      fireEvent.press(screen.getByTestId('mock-live-cancel'));
      expect(screen.queryByTestId('mock-live-finish')).toBeNull();

      fireEvent.press(screen.getByTestId('smart-scan-button'));
      await screen.findByTestId('mock-live-unavailable');
      const Modal = require('react-native').Modal;
      fireEvent(screen.UNSAFE_getAllByType(Modal)[1], 'requestClose');
      expect(screen.queryByTestId('mock-live-finish')).toBeNull();

      fireEvent.press(screen.getByTestId('smart-scan-button'));
      await act(async () => {
        fireEvent.press(await screen.findByTestId('mock-live-unavailable'));
      });
      expect(await screen.findByTestId('camera-view')).toBeTruthy();
      expect(screen.getByTestId('smart-scan-note')).toHaveTextContent(/Live scanning stopped/);
    });
  });
});
