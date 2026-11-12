/**
 * The smart-scan service facade: the remote calls hit the right endpoints and
 * the wrappers pass the current connectivity through to the memory layer.
 */
import { redirectSystemPath } from '../app/+native-intent';

const mockRequest = jest.fn();
const mockOnline = jest.fn(() => true);
const mockResolve = jest.fn();
const mockRemember = jest.fn();
const mockSync = jest.fn();
const mockBackfill = jest.fn();
const mockReadText = jest.fn();

jest.mock('../services/api', () => ({ request: (...args: unknown[]) => mockRequest(...args) }));
jest.mock('../services/offline', () => ({ isOnline: () => mockOnline() }));
jest.mock('../modules/label-reader', () => ({
  getLiveScannerView: jest.fn(),
  isLabelReaderAvailable: jest.fn(() => false),
  isLiveScanAvailable: jest.fn(() => false),
  readLabelText: (uri: string) => mockReadText(uri),
}));
jest.mock('../services/smartScan/memory', () => ({
  backfillScanMemoryOnce: (...a: unknown[]) => mockBackfill(...a),
  mergeFields: (a: object, b: object) => ({ ...b, ...a }),
  rememberScan: (...a: unknown[]) => mockRemember(...a),
  resolveScan: (...a: unknown[]) => mockResolve(...a),
  syncScanMemory: (...a: unknown[]) => mockSync(...a),
}));
jest.mock('../services/smartScan/parseLabel', () => ({ parseBoxLabel: (lines: string[]) => ({ name: lines[0] }) }));

// eslint-disable-next-line import/first
import * as scan from '../services/smartScan';

beforeEach(() => {
  jest.clearAllMocks();
  mockOnline.mockReturnValue(true);
});

describe('scanRemote', () => {
  it('looks up a barcode with and without a style code', () => {
    scan.scanRemote.lookup('123', undefined);
    expect(mockRequest).toHaveBeenLastCalledWith('/scan/lookup?barcode=123');
    scan.scanRemote.lookup('123', 'DZ5485-612');
    expect(mockRequest).toHaveBeenLastCalledWith('/scan/lookup?barcode=123&style_code=DZ5485-612');
  });

  it('learns, downloads and backfills', () => {
    scan.scanRemote.learn('123', { name: 'Tee' });
    expect(mockRequest).toHaveBeenLastCalledWith('/scan/learn', { method: 'POST', body: JSON.stringify({ barcode: '123', fields: { name: 'Tee' } }) });
    scan.scanRemote.download();
    expect(mockRequest).toHaveBeenLastCalledWith('/scan/memory');
    scan.scanRemote.backfill();
    expect(mockRequest).toHaveBeenLastCalledWith('/scan/backfill', { method: 'POST' });
  });
});

describe('wrappers', () => {
  it('pass connectivity and the remote to the memory layer', async () => {
    scan.resolveScan('123', 'S');
    expect(mockResolve).toHaveBeenCalledWith('123', { styleCode: 'S', online: true, remote: scan.scanRemote }, expect.any(Object));
    mockOnline.mockReturnValue(false);
    scan.rememberScan('123', { name: 'Tee' });
    expect(mockRemember).toHaveBeenCalledWith('123', { name: 'Tee' }, { online: false, remote: scan.scanRemote }, expect.any(Object));
    scan.syncScanMemory();
    expect(mockSync).toHaveBeenCalledWith(scan.scanRemote, expect.any(Object));
  });

  it('only backfills when online', async () => {
    mockOnline.mockReturnValue(false);
    expect(await scan.backfillScanMemoryOnce()).toBe(false);
    expect(mockBackfill).not.toHaveBeenCalled();
    mockOnline.mockReturnValue(true);
    mockBackfill.mockResolvedValueOnce(true);
    expect(await scan.backfillScanMemoryOnce()).toBe(true);
  });

  it('reads a label and keeps remembered fields on top', async () => {
    mockReadText.mockResolvedValueOnce(['Parsed name']);
    expect(await scan.readLabel('file://x.jpg', { sku: 'A1' })).toEqual({ name: 'Parsed name', sku: 'A1' });
    mockReadText.mockResolvedValueOnce(['Only parsed']);
    expect(await scan.readLabel('file://y.jpg')).toEqual({ name: 'Only parsed' });
  });
});

describe('redirectSystemPath', () => {
  it('moves a reset token from the fragment into the query', () => {
    expect(redirectSystemPath({ path: '/reset-password#token=a b', initial: true })).toBe('/reset-password?token=a%20b');
  });

  it('leaves other paths alone', () => {
    expect(redirectSystemPath({ path: '/settings', initial: false })).toBe('/settings');
    expect(redirectSystemPath({ path: '/inventory#x=1', initial: false })).toBe('/inventory#x=1');
    expect(redirectSystemPath({ path: '/reset-password#other=1', initial: false })).toBe('/reset-password#other=1');
  });
});
