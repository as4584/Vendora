import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ProductImage } from '../components/ProductImage';
import { Disclosure } from '../components/Disclosure';
import { Text } from 'react-native';

describe('Product photography', () => {
  it('has a clean missing-photo fallback', () => {
    const screen = render(<ProductImage label="Dunk Low" fallbackLabel="Add photo" />);
    expect(screen.getByLabelText('No photo: Dunk Low')).toBeTruthy();
    expect(screen.getByText('Add photo')).toBeTruthy();
  });

  it('replaces a failed image and recovers when a new URI arrives', () => {
    const screen = render(<ProductImage label="Dunk Low" uri="https://example.test/broken.jpg" />);
    fireEvent(screen.getByLabelText('Dunk Low'), 'error');
    expect(screen.getByLabelText('No photo: Dunk Low')).toBeTruthy();
    screen.rerender(<ProductImage label="Dunk Low" uri="https://example.test/new.jpg" />);
    expect(screen.getByLabelText('Dunk Low').props.source.uri).toContain('new.jpg');
  });
});

it('keeps secondary details collapsed and exposes expanded state to assistive technology', () => {
  const screen = render(<Disclosure title="Item details"><Text>Vendor notes</Text></Disclosure>);
  expect(screen.queryByText('Vendor notes')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Item details' }));
  expect(screen.getByText('Vendor notes')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Item details' }).props.accessibilityState.expanded).toBe(true);
  fireEvent.press(screen.getByRole('button', { name: 'Item details' }));
  expect(screen.queryByText('Vendor notes')).toBeNull();
});
