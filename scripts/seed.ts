// Loads campus places, the directory and the labeled example data into the real database.
// Run: node scripts/seed.ts            (adds anything missing, changes nothing else)
//      node scripts/seed.ts --reset    (clears the old example rows first so their times are fresh)

import { getDb } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";

const reset = process.argv.includes("--reset");
const counts = seed(getDb(), { reset });

console.log(reset ? "example data reset and seeded. rows per table:" : "seeded. rows per table:");
for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
