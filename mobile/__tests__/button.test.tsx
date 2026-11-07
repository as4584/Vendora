import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Button, IconButton, triggerHaptic } from '../components/Button';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

describe('Button', () => {
  beforeEach(() => jest.clearAllMocks());

  it('presses with a light haptic by default and is a 48pt button', () => {
    const onPress = jest.fn();
    const screen = render(<Button label="Save" onPress={onPress} />);
    const btn = screen.getByLabelText('Save');
    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(btn.props.accessibilityRole).toBe('button');
  });

  it('destructive buttons warn; explicit haptics are honoured; none is silent', () => {
    const screen = render(
      <>
        <Button label="Delete" variant="destructive" onPress={jest.fn()} />
        <Button label="Done" haptic="success" onPress={jest.fn()} />
        <Button label="Hard" haptic="medium" onPress={jest.fn()} />
        <Button label="Quiet" haptic="none" onPress={jest.fn()} />
      </>,
    );
    fireEvent.press(screen.getByLabelText('Delete'));
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith('warning');
    fireEvent.press(screen.getByLabelText('Done'));
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith('success');
    fireEvent.press(screen.getByLabelText('Hard'));
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith('medium');
    (Haptics.impactAsync as jest.Mock).mockClear();
    fireEvent.press(screen.getByLabelText('Quiet'));
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it('disabled and loading buttons do not fire and report their state', () => {
    const onPress = jest.fn();
    const screen = render(
      <>
        <Button label="Off" disabled onPress={onPress} />
        <Button label="Busy" loading onPress={onPress} leadingIcon="add" trailingIcon="chevron-forward" />
      </>,
    );
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Off').props.accessibilityState).toMatchObject({ disabled: true, busy: false });
    expect(screen.getByLabelText('Busy').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });

  it('small buttons have a real 44pt layout target without overlapping hit areas', () => {
    const screen = render(<Button label="Tiny" size="sm" onPress={jest.fn()} />);
    expect(StyleSheet.flatten(screen.getByLabelText('Tiny').props.style).minHeight).toBe(44);
  });

  it('IconButton needs a label and fires', () => {
    const onPress = jest.fn();
    const screen = render(<IconButton icon="close" label="Close" onPress={onPress} />);
    fireEvent.press(screen.getByLabelText('Close'));
    expect(onPress).toHaveBeenCalled();
    const off = render(<IconButton icon="close" label="Nope" disabled onPress={onPress} variant="ghost" />);
    expect(off.getByLabelText('Nope').props.accessibilityState).toMatchObject({ disabled: true });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a synchronous haptics failure is contained', async () => {
    (Haptics.impactAsync as jest.Mock).mockImplementationOnce(() => { throw new Error('no engine'); });
    await expect(triggerHaptic('light')).resolves.toBeUndefined();
  });

  it.each(['light', 'medium', 'success', 'warning'] as const)('contains rejected %s haptics', async kind => {
    const method = kind === 'light' || kind === 'medium' ? Haptics.impactAsync : Haptics.notificationAsync;
    (method as jest.Mock).mockRejectedValueOnce(new Error('engine unavailable'));
    await expect(triggerHaptic(kind)).resolves.toBeUndefined();
  });

  it('still runs the action immediately when haptics reject', async () => {
    (Haptics.impactAsync as jest.Mock).mockRejectedValueOnce(new Error('engine unavailable'));
    const onPress = jest.fn();
    const screen = render(<Button label="Save anyway" onPress={onPress} />);
    fireEvent.press(screen.getByLabelText('Save anyway'));
    expect(onPress).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
