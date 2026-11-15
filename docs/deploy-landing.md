# Deploying the website to Vercel

Four pages go to Vercel: the landing page, the staff dashboard, the "under the hood" panel and the privacy page. Together they are a plain static folder (`vercel-landing/`) with no server code, no database and no environment variables. The iMessage server stays on John's Mac and is never deployed.

The dashboard and the panel on the website run on **example data only** (see "Example data" below). They say so in a banner at the top, and their buttons change a copy in the visitor's browser and nothing else.

**Heads up: the page publishes John's phone number.** The number is baked into `index.html` and `qr.svg`, so anyone with the link can see it and text it. Troy still only answers chats that start with "hey troy", but the number itself is public for as long as the page is up. The build adds a `noindex` tag and header so search engines are asked not to list it. Take the page down after the hackathon (last section).

All commands run from the repo root, `/Users/johnwang/Documents/troy`.

## 1. Build the static folder

```sh
node scripts/build-landing.ts +1XXXXXXXXXX
```

Use Troy's real number in place of `+1XXXXXXXXXX`. If `TROY_NUMBER` is already set in the shell, `node scripts/build-landing.ts` on its own works too. The script never reads `.env`. With no number it stops with a message and writes nothing.

It writes only what the four pages need:

- `vercel-landing/index.html` with the number baked into the two meta tags (`troy-number`, `troy-sms`) and into the three links, so no `/api/landing` call is needed. Both Text Troy buttons open `sms:+1XXXXXXXXXX?&body=hey%20troy`, and the FAQ button opens the same number with "hey troy, i have a question" filled in.
- `vercel-landing/qr.svg`, the QR code for the Text Troy link
- `vercel-landing/dashboard.html`, `panel.html` and `privacy.html`, as they are in `public/` (the number is not on them)
- `vercel-landing/demo-data/*.json`, the example data the dashboard and the panel load, made fresh by every build
- `vercel-landing/landing/` (the pages' CSS, scripts and `conversations.json`; `nav.css` is the site navigation, `tool.css` the look of the three working pages, `demo.js` their data layer)
- `vercel-landing/img/` and `vercel-landing/assets/`, only the files the pages refer to (the six painting files, the chat photos and Troy's avatar)
- `vercel-landing/vercel.json` (clean URLs, cache headers, basic security headers)

`webchat.html` and everything else in `public/` are never copied.

Caching: the four pages, `qr.svg` and `demo-data/` are always revalidated. Everything in `landing/`, `img/` and `assets/` is cached for a year, and every page asks for each of them with `?v=<build id>`, which changes whenever the number, a page, the example data or any file changes. So a redeploy shows up right away.

Links between the pages are written as plain file names (`dashboard.html`, `panel.html`, `privacy.html`, and `./` for home). That works on the local Troy server and on any plain file server. On Vercel, `cleanUrls` answers `dashboard.html` with a redirect to `/dashboard`, so the address bar shows the short form.

The script prints the three links it built. To look at the page before deploying, serve the folder with any static file server, for example `cd vercel-landing && python3 -m http.server 3140`, then open `http://localhost:3140`.

Page weight, measured from the build on Nov 14: about 0.7 MB on a phone (the three 1600px paintings are 0.48 MB of that) and about 1.5 MB on a desktop screen (the 2560px paintings are 1.2 MB), before the host compresses the text files.

## Example data (the dashboard and the panel with no server)

Both pages ask for their data through `public/landing/demo.js`. It tries the live API first (`/api/settings`). On John's Mac with the server running that answers, and the pages behave exactly as they always have. Anywhere else the request fails, and for the rest of the visit the page loads `demo-data/*.json` instead, shows the banner "Example data. This is a demo of the staff view; nothing here is a real student or report.", stops polling and answers every button from a copy in memory. A toast says what Troy would have texted. Nothing is sent anywhere.

`scripts/build-demo-data.ts` makes those files: an in-memory database, the labeled example seed (`src/db/seed.ts`), the matcher on rule scores (no AI call), a few more example rows so every tab has something, then the real API routes are asked for their JSON. It never opens the real database and never reads `.env`. Before it returns anything it checks the output and stops the build if it finds a full phone number, a handle that is not a masked example number, a pickup code, a location field, a row that is not marked as an example, or the value of an environment variable that looks like a key, a number or an address. Settings are written without any environment facts (no `.env` allow-list, no provider).

- The DPS code check accepts one sample code, shown under the field on the demo page. It is a constant in `demo.js` and the real codes are never in the files.
- The eval tile shows the counts from the last eval run on the Mac that built the folder (`data/eval-latest.json`), or "no eval yet".
- `node scripts/build-demo-data.ts` on its own refreshes `public/demo-data/`, which is what a plain file server pointed at `public/` uses. Running the full build does that too.

## 2. First deploy (one time setup)

```sh
vercel login
vercel project create troy-usc
vercel link --cwd vercel-landing --project troy-usc --yes
vercel deploy --cwd vercel-landing --prod
```

- `vercel login` opens the browser to sign in. Skip it if `vercel whoami` already shows the right account.
- `vercel project create troy-usc` creates the empty project. `vercel link` then ties the `vercel-landing` folder to it and writes `vercel-landing/.vercel/`. Rebuilding does not touch that folder, so the link survives.
- `vercel deploy --prod` uploads the folder as is and prints the production URL. If the name is free the site is at `https://troy-usc.vercel.app`; otherwise use the URL the CLI prints, or check `vercel project inspect troy-usc`.
- If the account has more than one team, add `--scope <team>` to the `project create`, `link` and `deploy` commands.

Then open the URL on a phone, tap "Text Troy" and check Messages opens to the right number with "hey troy" filled in. On a laptop, scan the QR code. Open "For staff", "Under the hood" and "Privacy" from the top of the page and check the two working pages show the example data banner.

## 3. Redeploy after a change

After editing `public/index.html`, `dashboard.html`, `panel.html`, `privacy.html` or anything in `public/landing/`, `public/img/` or `public/assets/`, after changing the seed data or the API the example data comes from, or if the number changes:

```sh
node scripts/build-landing.ts +1XXXXXXXXXX
vercel deploy --cwd vercel-landing --prod
```

The production URL stays the same. To go back to the previous version: `vercel rollback --cwd vercel-landing`.

## The web simulator (one serverless function)

`simulator.html` is the page for visitors who are not on an Apple device. It talks to one function, `POST /api/sim`, which the build writes into `vercel-landing/api/` with a `package.json` beside it (source: `simulator/api/`, made by `scripts/build-sim.ts`). The function calls the Claude API for Troy's wording and is connected to nothing else: no Troy server, no database, nothing stored.

Before the first deploy that includes it, the Vercel project needs one environment variable, set by hand in the project's settings (Production, and Preview if previews should answer):

- `ANTHROPIC_API_KEY`: the key the function uses. Without it the page says the simulator is offline.
- `TROY_SIM` (optional): set to `off` to switch the simulator off without a redeploy of the pages. The function then answers "busy" and never calls the model.

- `TROY_SIM_SECRET` (optional): signs Troy's lines so the browser cannot hand back lines he never sent. Without it the signing key is derived from `ANTHROPIC_API_KEY` (one way), which is fine.

Limits are in `simulator/api/_handler.js` (`LIMITS`): 25 messages per visitor conversation, 600 characters each, one photo of at most 1 MB, 500 output tokens, a 20 second cut-off, same-origin requests only, and in memory per running instance: 40 model calls per visitor IP and 600 in total per 10 minutes, 20 at once.

These limits slow a casual abuser down; they do not stop a determined one. The Origin check only stops other websites' pages: a script can send any Origin it likes. Counts live in one instance's memory, so they reset on a cold start and are not shared between instances. The real brakes are a monthly spend limit on the API key (set it in the Claude Console before going live) and `TROY_SIM=off`.

Local preview without Vercel: `npm run sim`, then open http://localhost:3220/simulator.html.

## 4. Take it down after the hackathon

Quick switch, keeps the project (visitors see an error page until it is resumed):

```sh
vercel project pause troy-usc
```

Remove it for good, including every deployment and its URLs:

```sh
vercel project delete troy-usc
rm -rf vercel-landing
```

Older deployments keep their own unique URLs with whatever number was baked in at the time, so deleting the project (not just redeploying) is what actually takes the number off Vercel.

## Notes

- `vercel-landing/` is generated. Don't edit it by hand; edit the pages in `public/` or `public/landing/` and rebuild. It has the phone number in it, so the repo's `.gitignore` excludes it.
- The same `public/index.html` still runs on the local server. There the meta tags are empty, so `landing/config.js` asks `api/landing` for the number (from `TROY_NUMBER` at request time) and the QR comes from `/qr.svg`. With no number set, the buttons are disabled and say "number coming soon".
- `node --test tests/landing.test.ts` checks the page's copy rules, the links between the pages, the local routes, the example data's privacy guard and the build.
- Nothing here costs money on Vercel's free plan as far as a static page goes, but check the account's plan if that matters.
