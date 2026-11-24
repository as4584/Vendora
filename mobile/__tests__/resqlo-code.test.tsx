import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import * as apiMock from '../services/api';
import { ResqloCode } from '../components/ResqloCode';

jest.mock('../services/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiError, getResqloCode: jest.fn() };
});

const PRODUCT = {
  rq_code: 'RQ-7F3K9XA', style_code: 'CU1110-010', size: '10', name: 'Jordan 4 Black Cat',
  brand: 'Jordan', category: null, color: null, times_confirmed: 3,
};

describe('ResqloCode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the universal code for the product', async () => {
    (apiMock.getResqloCode as jest.Mock).mockResolvedValueOnce(PRODUCT);
    const screen = render(<ResqloCode itemId="i1" />);
    expect((await screen.findByTestId('resqlo-code')).props.children).toBe('RQ-7F3K9XA');
    expect(screen.getByText(/in size 10 has this code in every store/)).toBeTruthy();
  });

  it('omits the size when the product has none', async () => {
    (apiMock.getResqloCode as jest.Mock).mockResolvedValueOnce({ ...PRODUCT, size: null });
    const screen = render(<ResqloCode itemId="i1" />);
    expect(await screen.findByText(/Every Jordan 4 Black Cat has this code/)).toBeTruthy();
  });

  it('asks for a style code on 422 and hides on other errors', async () => {
    const { ApiError } = jest.requireMock('../services/api');
    (apiMock.getResqloCode as jest.Mock).mockRejectedValueOnce(new ApiError('need style', 422));
    const screen = render(<ResqloCode itemId="i1" />);
    expect(await screen.findByText(/Add a style code/)).toBeTruthy();

    (apiMock.getResqloCode as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const other = render(<ResqloCode itemId="i2" />);
    await waitFor(() => expect(apiMock.getResqloCode).toHaveBeenCalledTimes(2));
    expect(other.queryByText('Resqlo code')).toBeNull();
  });

  it('ignores a late response after unmount', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    (apiMock.getResqloCode as jest.Mock)
      .mockReturnValueOnce(new Promise((r) => { resolve = r; }))
      .mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    render(<ResqloCode itemId="i1" />).unmount();
    render(<ResqloCode itemId="i2" />).unmount();
    resolve(PRODUCT);
    const { ApiError } = jest.requireMock('../services/api');
    reject(new ApiError('x', 422));
    await waitFor(() => expect(apiMock.getResqloCode).toHaveBeenCalledTimes(2));
  });
});
