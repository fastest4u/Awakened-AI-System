import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import App from './App';

test('renders the Memory Studio brand', async () => {
  render(<App />);
  expect(await screen.findByText('Memory Studio')).toBeInTheDocument();
  expect(await screen.findByText('Project Memory V2')).toBeInTheDocument();
});
