import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { Button } from '../components/Button';
import { Pill, Stepper } from '../components/ui';
import { FONT_SCALE } from '../theme/tokens';

/**
 * Dynamic Type: chrome in fixed-size boxes caps its growth; body copy does not.
 * (The web layout gate renders key screens at FONT_SCALE.chrome; see
 * e2e/visual/layout.spec.ts "large text".)
 */
describe('Dynamic Type caps', () => {
  it('keeps caps moderate so text still grows for people who need it', () => {
    for (const cap of Object.values(FONT_SCALE)) {
      expect(cap).toBeGreaterThanOrEqual(1.3);
      expect(cap).toBeLessThanOrEqual(1.5);
    }
  });

  it('caps pill labels', () => {
    const screen = render(<Pill label="In stock" />);
    expect(screen.getByText('In stock').props.maxFontSizeMultiplier).toBe(FONT_SCALE.chrome);
  });

  it('caps stepper numbers but lets step labels scale', () => {
    const screen = render(<Stepper steps={['Scan', 'Price']} active={0} />);
    expect(screen.getByText('1').props.maxFontSizeMultiplier).toBe(FONT_SCALE.chrome);
    expect(screen.getByText('Scan').props.maxFontSizeMultiplier).toBeUndefined();
  });

  it('caps button labels at the control size', () => {
    const screen = render(<Button label="Log sale" onPress={() => undefined} />);
    expect(screen.getByText('Log sale').props.maxFontSizeMultiplier).toBe(FONT_SCALE.control);
  });

  it('never turns font scaling off on plain text', () => {
    const screen = render(<Text>Body copy</Text>);
    expect(screen.getByText('Body copy').props.allowFontScaling).not.toBe(false);
  });
});
