import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { blobToBase64, readBase64Chunk } from '../utils/chunkedUpload';

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn(async () => 'QUJD'),
}));

describe('readBase64Chunk', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    jest.restoreAllMocks();
  });

  it('reads a byte range natively as base64', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    await expect(readBase64Chunk('file:///a.csv', 10, 5)).resolves.toBe('QUJD');
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('file:///a.csv', {
      encoding: 'base64', position: 10, length: 5,
    });
  });

  it('slices the blob on web', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const blob = new Blob(['0123456789']);
    jest.spyOn(global, 'fetch').mockResolvedValue({ blob: async () => blob } as unknown as Response);
    await expect(readBase64Chunk('blob:x', 2, 3)).resolves.toBe(Buffer.from('234').toString('base64'));
  });

  it('encodes large blobs in pieces without overflowing the call stack', async () => {
    const big = new Uint8Array(100_000).fill(65);
    await expect(blobToBase64(new Blob([big]))).resolves.toBe(Buffer.from(big).toString('base64'));
  });
});
