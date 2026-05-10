// vs-fork Plan 4 §C BLOCK-2 — vitest global setup.
//
// Loads @testing-library/jest-dom matchers (toBeInTheDocument,
// toBeChecked, toHaveAttribute, etc.) for every test file.

import "@testing-library/jest-dom/vitest"
