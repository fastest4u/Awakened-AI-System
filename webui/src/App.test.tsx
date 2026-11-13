import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import App from './App';

test('renders the Memory Studio brand', () => {
  render(<App />);
  expect(screen.getByText('Memory Studio')).toBeInTheDocument();
  expect(screen.getByText('Project Memory V2')).toBeInTheDocument();
});
