import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Each test starts from a clean localStorage so storage/driveSync state never
// leaks across cases.
afterEach(() => {
  localStorage.clear();
});
