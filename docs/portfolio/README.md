# Troy portfolio kit

Everything for showing Troy after the AI@USC Hackathon (Nov 14 to 15, 2026). Copy is in John's voice, plain and short, with no em dashes. Only true facts are used; anything to fill in is marked `[add]`.

## Links

- Site (live, iMessage switched off, buttons go to the browser simulator): https://texttroy.vercel.app
- Try it in the browser: https://texttroy.vercel.app/simulator
- Staff dashboard (example data): https://texttroy.vercel.app/dashboard
- Under the hood (example data): https://texttroy.vercel.app/panel
- Code: https://github.com/jhwn72/troy
- Devpost: `[add]`
- Demo video: `[add]`

## Images (in this folder, 1800 px wide webp, same as the other portfolio projects)

- `troy-hero.webp`: the landing page hero, two phones mid-conversation over the painted campus. Use as the cover.
- `troy-dashboard.webp`: the staff dashboard for DPS, FMS, Housing and USG (example data banner visible).
- `troy-panel.webp`: "Under the hood", the five steps every connection runs through.

To use them on johncwang.me, copy them into `johnwang-portfolio/public/projects/`.

## Portfolio entry (paste into `johnwang-portfolio/src/content/projects.ts`)

```ts
  {
    id: "troy",
    title: "Troy",
    column: "shipped",
    initials: "TR",
    kind: "Hackathon",
    date: "2026-11-15",
    tagline: "He knows a guy.",
    meta: "AI@USC Hackathon 2026 · iMessage agent",
    problem:
      "USC already has the programs and the people. Students just find out by luck, and nobody reads the emails. Troy is an AI you text over iMessage that connects you to the right person, office or item, then steps back. Lose your AirPods and he checks who found them. Find a wallet and he gets it home without either side handing out a number. Spot something broken and the right office hears about it.",
    built: [
      "One engine for every connection: understand, find, verify, connect, follow up",
      "Lost and found with a blind check: the owner describes the item before seeing anything, and the finder has the final say",
      "Send a photo instead of filling out a form. Troy reads it and routes it",
      "Location decides who hears about it, so only people close enough to act get a text",
      "A privacy gate built first: he ran on my own number, so everything not meant for him is ignored completely",
      "A staff dashboard for DPS, FMS, Housing and USG, and a browser simulator so anyone can try him",
    ],
    sections: [
      {
        heading: "How I built it",
        items: [
          "Solo, by directing AI coding agents that each owned their own files, with separate agents whose only job was to break it",
          "Code owns the facts (codes, counts, walking times, verification). The AI only decides how to say it",
          "1,079 automated tests, and zero wrong handoffs across 40 lost and found test cases",
        ],
      },
      {
        heading: "Fine print",
        items: [
          "Troy ran live on iMessage for the hackathon, and a judge texted him there from their own phone. It's switched off now since it ran on my personal number.",
          "The browser simulator is the same Troy without real campus connections. The office links were mocked, and nobody at USC has adopted it yet.",
        ],
      },
    ],
    results: ["Live on iMessage", "1,079 tests", "0 wrong handoffs"],
    stack: ["TypeScript", "Node.js", "Claude", "SQLite", "iMessage", "Vercel"],
    link: {
      label: "Try Troy",
      href: "https://texttroy.vercel.app/simulator",
      note: "Text him in your browser. iMessage is switched off since the hackathon.",
      kind: "live",
    },
    moreLinks: [
      { label: "The site", href: "https://texttroy.vercel.app" },
      { label: "Code on GitHub", href: "https://github.com/jhwn72/troy" },
      // { label: "Devpost write-up", href: "[add]" },
    ],
    images: ["/projects/troy-hero.webp", "/projects/troy-dashboard.webp", "/projects/troy-panel.webp"],
  },
```

## Devpost update (paste at the top of the Devpost page)

> **Update, Nov 15:** Troy ran live on iMessage through the hackathon and judging. It's switched off now because it ran on my personal number. You can still try him at https://texttroy.vercel.app/simulator, and the code is at https://github.com/jhwn72/troy.

Also on Devpost, replace any "Text Troy" link or QR image with the simulator link.

## Resume

**Troy**, AI iMessage agent for campus services · AI@USC Hackathon · Nov 2026
- Built solo an AI agent students text over iMessage to reach the right person, office or lost item, running live on a real phone during judging
- Designed a blind verification flow for lost and found with zero wrong handoffs across 40 test cases, backed by 1,079 automated tests
- Directed parallel AI coding agents with shared contracts, plus agents assigned to break the privacy gate and verification

## LinkedIn post

> Spent the AI@USC Hackathon building Troy, an AI you text over iMessage that connects USC students to the right person, office or item.
>
> It started with a lost wallet. USC has DPS lost and found, shuttles, a farmers market and student funding, but most students only hear about them by luck. So I made it a text: send a photo of something you found and Troy finds the owner, checks it's really theirs without showing them anything first, and sets up the handoff.
>
> He ran live on my own number, so the first thing I built was a privacy gate that ignores every chat that isn't his. 1,079 tests later, a judge was texting him from their own phone.
>
> iMessage is off now, but you can try him in your browser: https://texttroy.vercel.app/simulator
> Code: https://github.com/jhwn72/troy

## One-liners

- **Short:** Troy is an AI you text that connects USC students to the right person, office or item.
- **Contrast:** ChatGPT gives you information. Troy gets you connected.
- **For a conversation:** USC already has the programs. Students just don't find out. Troy makes all of it one text away.

## Honesty checks

- Don't say USC, DPS, FMS, Housing or USG adopted or approved it. Nobody at USC has been told.
- Office systems were mocked. Rides, the USG member and the technician ran on example data.
- No user counts or testimonials: there were testers and judges, not real users.
- Don't claim a placement.
