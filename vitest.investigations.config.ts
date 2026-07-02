import { defineConfig } from "vitest/config";

/**
 * Config for the empirical investigation scripts in `investigations/`.
 *
 * These are NOT part of the normal test suite (`npm test`): they don't assert,
 * they sweep parameters and `console.log` the numbers we use to fit the formulas
 * baked into the operations (e.g. the gyro lift exponent). Run them on demand
 * with `npm run investigate` (optionally passing a path/name filter).
 */
export default defineConfig({
  test: {
    include: ["investigations/**/*.investigate.ts"],
    // let the console.logs through and don't truncate them
    disableConsoleIntercept: true,
  },
});
