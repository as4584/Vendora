import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import {
  ActionButton,
  ActionTile,
  Card,
  ChipRow,
  HeaderTitle,
  MetricCard,
  Pill,
  SectionLabel,
  Stepper,
  TabGlyph,
} from '../components/ui';

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
});
