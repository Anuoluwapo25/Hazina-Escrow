/**
 * gen-fee-vectors.ts — CLI wrapper for issue #540.
 *
 *   npm run gen:fee-vectors --prefix backend
 *
 * All the logic lives in `src/common/fee-vectors.ts` so it sits under the
 * TypeScript `rootDir` and is typechecked, linted and covered like any other
 * backend module. This file only writes the result to disk.
 */

import { writeFileSync } from 'fs';

import { FIXTURE_PATH, PRICES, buildFixture, render } from '../src/common/fee-vectors';

writeFileSync(FIXTURE_PATH, render(buildFixture()), 'utf8');
process.stdout.write(`wrote ${PRICES.length} vectors to ${FIXTURE_PATH}\n`);
