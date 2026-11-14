# Deploying the landing page to Vercel

Only the landing page goes to Vercel. It is a plain static folder (`vercel-landing/`) with no server code, no database and no environment variables. The iMessage server stays on John's Mac and is never deployed.

**Heads up: the page publishes John's phone number.** The number is baked into `index.html` and `qr.svg`, so anyone with the link can see it and text it. Troy still only answers chats that start with "hey troy", but the number itself is public for as long as the page is up. The build adds a `noindex` tag and header so search engines are asked not to list it. Take the page down after the hackathon (last section).

All commands run from the repo root, `/Users/johnwang/Documents/troy`.

## 1. Build the static folder

```sh
node scripts/build-landing.ts +1XXXXXXXXXX
```

Use Troy's real number in place of `+1XXXXXXXXXX`. If `TROY_NUMBER` is already set in the shell, `node scripts/build-landing.ts` on its own works too. The script never reads `.env`. With no number it stops with a message and writes nothing.

It writes:

- `vercel-landing/index.html` with the sms link and number baked in (no `/api/landing` call needed)
- `vercel-landing/qr.svg`, the QR code for the same link
- `vercel-landing/assets/`, copied from `public/assets/`
- `vercel-landing/vercel.json` (clean URLs, cache headers, basic security headers)

To look at it before deploying, serve the folder with any static file server, for example `npx serve vercel-landing`.

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

Then open the URL on a phone, tap "Text Troy" and check Messages opens to the right number with "hey troy" filled in. On a laptop, scan the QR code.

## 3. Redeploy after a change

After editing `public/index.html` or anything in `public/assets/`, or if the number changes:

```sh
node scripts/build-landing.ts +1XXXXXXXXXX
vercel deploy --cwd vercel-landing --prod
```

The production URL stays the same. To go back to the previous version: `vercel rollback --cwd vercel-landing`.

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

- `vercel-landing/` is generated. Don't edit it by hand; edit `public/index.html` and rebuild. It has the phone number in it, so think before committing it. The repo's `.gitignore` does not exclude it yet.
- The same `public/index.html` still runs on the local server. There it asks `/api/landing` for the number, which comes from `TROY_NUMBER` at request time.
- Nothing here costs money on Vercel's free plan as far as a static page goes, but check the account's plan if that matters.
