import { defineConfig } from "vitest/config";

/**
 * Config for the empirical investigation scripts in `investigations/`.
 *
 * They are not part of the normal test suite (`npm test`) and don't assert: they sweep
 * parameters and console.log the numbers the formulas baked into the operations are fit
 * from, such as the gyro lift exponent. Run them on demand with `npm run investigate`,
 * optionally passing a path / name filter.
 */
export default defineConfig({
  test: {
    include: ["investigations/**/*.investigate.ts"],
    // let the console.logs through untruncated
    disableConsoleIntercept: true,
  },
});
