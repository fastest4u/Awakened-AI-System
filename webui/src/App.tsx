import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { AppProviders } from './providers/app-providers';

const router = createAppRouter();

export default function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
