import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { OfflineBanner } from '../components/OfflineBanner';
import { BRAND } from '../theme/tokens';

const dismissFailed = jest.fn();
let mockState = { online: false, pending: 0, failed: 0, dismissFailed };
jest.mock('../context/network', () => ({ useNetwork: () => mockState }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));

describe('Offline notice contrast', () => {
  beforeEach(() => { dismissFailed.mockClear(); });
  it.each([
    [{ online: false, pending: 0, failed: 0 }, "Offline · changes will sync when you're back"],
    [{ online: false, pending: 1, failed: 0 }, 'Offline · 1 change queued'],
    [{ online: false, pending: 2, failed: 0 }, 'Offline · 2 changes queued'],
    [{ online: true, pending: 1, failed: 0 }, 'Syncing 1 change…'],
    [{ online: true, pending: 2, failed: 0 }, 'Syncing 2 changes…'],
    [{ online: true, pending: 0, failed: 1 }, "1 offline change couldn't be saved. Please check and re-enter."],
    [{ online: true, pending: 0, failed: 2 }, "2 offline changes couldn't be saved. Please check and re-enter."],
  ] as const)('keeps the notice readable: %s', (next, message) => {
    mockState = { ...next, dismissFailed };
    const screen = render(<OfflineBanner />);
    expect(StyleSheet.flatten(screen.getByText(message).props.style).color).toBe(BRAND.onPrimary);
    if (next.failed) {
      fireEvent.press(screen.getByRole('button'));
      expect(dismissFailed).toHaveBeenCalledTimes(1);
    }
  });
  it('stays hidden when online with no backlog', () => {
    mockState = { online: true, pending: 0, failed: 0, dismissFailed };
    expect(render(<OfflineBanner />).toJSON()).toBeNull();
  });
});
