import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import {
  ActionButton,
  ActionTile,
  Card,
  ChipRow,
  GradientCard,
  HeaderTitle,
  Icon,
  IconCircle,
  MetricCard,
  Pill,
  SectionLabel,
  Sparkline,
  StatCard,
  Stepper,
  TabGlyph,
} from '../components/ui';
import { ScannerOverlay } from '../components/ScannerOverlay';

describe('shared UI primitives', () => {
  it('renders every visual variant and preserves button accessibility behavior', () => {
    const onPress = jest.fn();
    const screen = render(
      <>
        <Card><Text>Card body</Text></Card>
        <SectionLabel>Section</SectionLabel>
        <HeaderTitle title="Title" subtitle="Subtitle" right={<Text>Right</Text>} />
        <HeaderTitle title="No subtitle" />
        {(['neutral', 'primary', 'success', 'warning', 'danger', 'info'] as const).map((tone) => (
          <Pill key={tone} label={tone} tone={tone} />
        ))}
        {(['primary', 'secondary', 'success', 'ghost'] as const).map((tone) => (
          <ActionButton key={tone} label={`Action ${tone}`} tone={tone} onPress={onPress} compact />
        ))}
        <ActionButton label="Disabled" onPress={onPress} disabled />
        <MetricCard label="Metric" value="10" helper="Helper" wide />
        <MetricCard label="Plain metric" value="1" />
        <ActionTile glyph="A" label="Tile" helper="Tile helper" onPress={onPress} />
        <ActionTile glyph="B" label="Plain tile" onPress={onPress} />
        <Stepper steps={['Done', 'Current', 'Later']} active={1} />
        <TabGlyph glyph="D" active />
        <TabGlyph glyph="I" active={false} />
        <ChipRow><Text>Chip</Text></ChipRow>
      </>,
    );
    fireEvent.press(screen.getByLabelText('Action primary'));
    fireEvent.press(screen.getByLabelText('Tile. Tile helper'));
    fireEvent.press(screen.getByLabelText('Plain tile'));
    expect(screen.getByLabelText('Disabled').props.accessibilityState).toEqual({ disabled: true });
    expect(onPress).toHaveBeenCalledTimes(3);
    expect(screen.getByText('D')).toBeTruthy();
    expect(screen.getByText('I')).toBeTruthy();
  });

  it('renders the redesign primitives and their branch variants', () => {
    const onPress = jest.fn();
    const screen = render(
      <>
        <Icon name="home" />
        <IconCircle name="cube-outline" />
        <IconCircle name="cash-outline" tone="muted" color="#fff" />
        <GradientCard><Text>Hero</Text></GradientCard>
        <GradientCard colors={['#111111', '#222222']}><Text>Hero custom</Text></GradientCard>
        <Sparkline data={[5]} />
        <Sparkline data={[1, 4, 2, 8, 3]} stroke="#8E6BFF" />
        <StatCard label="Up" value="$10" delta="+5%" deltaTone="up" icon="cube-outline" />
        <StatCard label="Down" value="$9" delta="-2%" deltaTone="down" />
        <StatCard label="Tappable" value="42" delta="View" deltaTone="muted" onPress={onPress} />
        <StatCard label="Bare" value="0" />
      </>,
    );
    fireEvent.press(screen.getByText('Tappable'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Up')).toBeTruthy();
    expect(screen.getByText('Bare')).toBeTruthy();
  });

  it('renders the animated scanner overlay with and without a cancel action', () => {
    const onCancel = jest.fn();
    const withCancel = render(<ScannerOverlay hint="Scan now" onCancel={onCancel} />);
    fireEvent.press(withCancel.getByLabelText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(withCancel.getByText('Scan now')).toBeTruthy();
    withCancel.unmount(); // exercises the animation-loop cleanup

    const bare = render(<ScannerOverlay />);
    expect(bare.getByText('Point at a barcode to scan')).toBeTruthy();
    expect(bare.queryByLabelText('Cancel')).toBeNull();
    bare.unmount();
  });
});
