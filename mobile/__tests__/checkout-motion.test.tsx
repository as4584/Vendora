import React from 'react';
import { Animated } from 'react-native';
import { render } from '@testing-library/react-native';
import { StockLabel } from '../components/StockLabel';
import { CartNotice } from '../components/CartNotice';
import { useReducedMotion } from '../components/useReducedMotion';
jest.mock('../components/useReducedMotion', () => ({ useReducedMotion: jest.fn(() => true) }));

describe('checkout motion', () => {
  const start = jest.fn();
  const stop = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop } as any);
  });
  afterEach(() => jest.restoreAllMocks());
  it('always shows actual stock and stays still under Reduce Motion', () => {
    const screen = render(<StockLabel quantity={6} />);
    screen.rerender(<StockLabel quantity={2} />);
    expect(screen.getByText('Low stock 2')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    screen.rerender(<StockLabel quantity={0} />);
    expect(screen.getByText('Stock 0')).toBeTruthy();
  });
  it('animates only a changed quantity and cancels on unmount', () => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    const screen = render(<StockLabel quantity={6} />);
    expect(start).not.toHaveBeenCalled();
    screen.rerender(<StockLabel quantity={5} />);
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Stock 5')).toBeTruthy();
    screen.unmount();
    expect(stop).toHaveBeenCalled();
  });
  it('confirms the scanned item without motion when reduced', () => {
    const screen = render(<CartNotice name="Dunk Low" />);
    expect(screen.getByText('In your cart · Dunk Low')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });
  it('cleans up the cart entrance animation', () => {
    (useReducedMotion as jest.Mock).mockReturnValue(false);
    const screen = render(<CartNotice name="Dunk Low" />);
    expect(start).toHaveBeenCalledTimes(1);
    screen.unmount();
    expect(stop).toHaveBeenCalled();
  });
});
