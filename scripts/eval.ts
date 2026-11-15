// Run the lost and found eval and print the score.
//   node --env-file=.env scripts/eval.ts [--no-ai] [--limit N]
// Without an API key (or with --no-ai) it runs the deterministic fallback and says so. In that mode a passing
// description is "sent_to_finder" (the finder decides), never a handoff.
// The cases are fictional example data (evals/cases.json).

import { aiAvailable } from "../src/ai.ts";
import { runEval } from "../src/eval.ts";

const args = process.argv.slice(2);
const noAi = args.includes("--no-ai");
const limitAt = args.indexOf("--limit");
const limitRaw = limitAt >= 0 ? Number(args[limitAt + 1]) : NaN;
const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

const wantAi = !noAi;
if (noAi) console.log("fallback mode (--no-ai): deterministic rules only, no model calls");
else if (!aiAvailable()) console.log("fallback mode: no ANTHROPIC_API_KEY, deterministic rules only");
else console.log("ai mode: model ranks and scores, rules are the backup");
console.log("cases are fictional example data\n");

const result = await runEval({ useAi: wantAi, limit });

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
console.log(`${pad("id", 7)}${pad("kind", 12)}${pad("expected", 12)}${pad("decision", 16)}${pad("finder", 8)}${pad("conf", 6)}${pad("desc", 6)}${pad("src", 10)}result`);
for (const c of result.cases) {
  const src = c.descriptionSource && c.descriptionSource !== c.matchSource ? `${c.matchSource}/${c.descriptionSource}` : c.matchSource;
  const verdict = c.correct ? "ok" : c.wrongHandoff ? "WRONG HANDOFF" : c.sentToFinder ? "finder is the last check" : "missed";
  console.log(
    `${pad(c.id, 7)}${pad(c.kind, 12)}${pad(c.expected, 12)}${pad(c.decision, 16)}${pad(c.sentToFinder ? "asked" : "-", 8)}${pad(c.confidence, 6)}${pad(c.descriptionScore ?? "-", 6)}${pad(src, 10)}${verdict}${c.error ? " (error)" : ""}`,
  );
}

console.log("");
for (const [kind, k] of Object.entries(result.byKind)) console.log(`${pad(kind, 12)}${k.correct} of ${k.total}`);
console.log("");
// A rule-score pass is never a handoff: the finder is shown the claimant's words and decides.
const finder = result.mode === "fallback" || result.sentToFinder > 0 ? `, ${result.sentToFinder} sent to the finder` : "";
console.log(`${result.correct} of ${result.total} correct, ${result.wrong} wrong, ${result.wrongHandoffs} wrong handoffs${finder} (${result.mode} mode)`);
if (result.sentToFinderNotOwner > 0) console.log(`${result.sentToFinderNotOwner} of those were not the owner: the finder is the last check there`);
// Plain found items (nothing on them only an owner would know): a description that fits goes to the finder.
if (result.plain && result.plain.total > 0) {
  const p = result.plain;
  console.log("");
  for (const c of p.cases) console.log(`${pad(c.id, 7)}${pad(c.kind, 12)}${pad(c.expected, 12)}${pad(c.decision, 16)}${pad(c.verdict ?? "-", 14)}${c.correct ? "ok" : c.wrongHandoff ? "WRONG HANDOFF" : c.sentToFinder ? "finder is the last check" : "missed"}`);
  console.log(`plain items: ${p.correct} of ${p.total} correct, ${p.wrongHandoffs} wrong handoffs, ${p.sentToFinder} sent to the finder, ${p.sentToFinderNotOwner} of those not the owner`);
}
process.exit(0);
