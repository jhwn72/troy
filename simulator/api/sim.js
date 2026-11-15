// POST /api/sim on the static site: Troy's replies for the web simulator. One stateless function.
// Everything it does is in _handler.js; the prompt and the fixed safety copy are in _sim-data.js, which
// scripts/build-sim.ts writes next to this file in vercel-landing/api/ at build time.

import { createSimHandler } from "./_handler.js";
import * as data from "./_sim-data.js";

const handle = createSimHandler({ data });

export default {
  fetch(request) {
    return handle(request);
  },
};
