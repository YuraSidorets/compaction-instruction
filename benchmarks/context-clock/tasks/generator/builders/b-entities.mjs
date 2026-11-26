// Category B: entity and relationship tracking. Ownership changes, team renames, dependencies added and removed,
// on-call responsibility moved. Answers need the relationships as they are at the end, under the latest names.
import { stagePlan } from "./common.mjs";

const SERVICES = [
  "billing-api", "search-svc", "auth-gw", "ledger-svc", "notify-svc", "media-proc", "geo-api", "report-gen",
  "cart-svc", "feed-svc", "rank-svc", "mail-relay", "quota-svc", "audit-log",
];
const TEAM_PAIRS = [
  ["team-core", "team-platform"], ["team-payments", "team-money"], ["team-growth", "team-acquisition"], ["team-infra", "team-foundation"],
  ["team-data", "team-insights"], ["team-edge", "team-perimeter"], ["team-mobile", "team-apps"],
];
const ONCALL = ["ana", "bo", "chen", "dara", "eli", "femi", "gus", "hana"];

export function buildEntities(story, p) {
  const { rng, stages } = story;
  // v03 tasks pass their own value pools; the default pools keep the v0.2 tasks byte-identical.
  const SVC = p.pools?.services ?? SERVICES;
  const ONC = p.pools?.oncall ?? ONCALL;
  const services = rng.sample(SVC, Math.min(Math.max(4, p.entities), SVC.length));
  const pairs = rng.sample(p.pools?.teamPairs ?? TEAM_PAIRS, 4);
  const teamUniverse = pairs.flat();
  const oldTeams = pairs.map((x) => x[0]);
  const owner = {};
  const deps = {};
  for (const s of services) {
    owner[s] = story.var(`owner.${s}`, { label: `the owning team of ${s}`, domain: "team", options: teamUniverse });
    deps[s] = story.var(`deps.${s}`, { label: `the dependencies of ${s}`, type: "set", options: services.filter((x) => x !== s) });
  }
  const watched = services.slice(0, 2);
  const oncall = {};
  for (const s of watched) oncall[s] = story.var(`oncall.${s}`, { label: `the on-call engineer for ${s}`, options: ONC });

  // Initial specification: owners, a dependency chain of depth p.depth, on-call.
  for (const s of services) story.set(0, owner[s], rng.pick(oldTeams));
  const chain = services.slice(0, p.depth + 1);
  for (let i = 0; i < chain.length - 1; i += 1) story.add(0, deps[chain[i]], chain[i + 1]);
  for (const s of services.slice(p.depth + 1)) {
    if (rng.chance(0.5)) story.add(0, deps[s], rng.pick(services.filter((x) => x !== s)));
  }
  for (const s of watched) story.set(0, oncall[s], rng.pick(ONC));

  // Changes over the stages.
  const plan = stagePlan(rng, p.updates, stages);
  const renamed = [];
  const liveTeams = () => pairs.map((pr) => (renamed.includes(pr[0]) ? pr[1] : pr[0]));
  const renameStages = new Set([rng.int(2, stages), rng.int(2, stages)]);
  let lastStage = 0;
  for (const stage of plan) {
    if (renameStages.has(stage) && stage !== lastStage) {
      renameStages.delete(stage);
      const live = pairs.filter((pr) => !renamed.includes(pr[0]) && Object.values(story.cur).includes(pr[0]));
      if (live.length > 0) {
        const pr = rng.pick(live);
        story.ev(stage, "supersede", { op: "rename", domain: "team", from: pr[0], to: pr[1] });
        renamed.push(pr[0]);
        lastStage = stage;
        continue;
      }
    }
    lastStage = stage;
    const r = rng.float();
    const s = rng.pick(services);
    if (r < 0.35) {
      story.set(stage, owner[s], rng.pickOther(liveTeams(), story.cur[owner[s]]), { kind: "supersede" });
    } else if (r < 0.62) {
      const cand = services.filter((x) => x !== s && !story.cur[deps[s]].includes(x));
      if (cand.length > 0) story.add(stage, deps[s], rng.pick(cand));
    } else if (r < 0.85) {
      if (story.cur[deps[s]].length > 0) story.remove(stage, deps[s], rng.pick(story.cur[deps[s]]));
      else story.add(stage, deps[s], rng.pickOther(services, s));
    } else {
      const w = rng.pick(watched);
      story.set(stage, oncall[w], rng.pickOther(ONC, story.cur[oncall[w]]), { kind: "supersede" });
    }
  }
  // Guarantees at the last stage (the steering copy is exact there).
  const last = stages;
  if (renamed.length === 0) {
    const pr = pairs.find((x) => Object.values(story.cur).includes(x[0]));
    story.ev(last, "supersede", { op: "rename", domain: "team", from: pr[0], to: pr[1] });
    renamed.push(pr[0]);
  }
  const focus = services[0];
  const before = story.cur[owner[focus]];
  story.set(last, owner[focus], rng.pickOther(liveTeams(), before), { kind: "supersede" });
  const depFocus = services[1];
  if (story.cur[deps[depFocus]].length === 0) story.add(last, deps[depFocus], services[2]);
  story.add(last, deps[depFocus], rng.pick(services.filter((x) => x !== depFocus && !story.cur[deps[depFocus]].includes(x))));
  story.remove(last, deps[depFocus], story.cur[deps[depFocus]][0]);
  if (story.cur[deps[depFocus]].length === 0) story.add(last, deps[depFocus], services.find((x) => x !== depFocus));
  story.set(last, oncall[watched[1]], rng.pickOther(ONC, story.cur[oncall[watched[1]]]), { kind: "supersede" });

  // Questions.
  const renamedTo = pairs.find((x) => x[0] === renamed[0])[1];
  const ownerVars = services.map((s) => owner[s]);
  const labels = Object.fromEntries(services.map((s) => [owner[s], s]));
  let teamQ = renamedTo;
  if (!services.some((s) => story.cur[owner[s]] === teamQ)) teamQ = story.cur[owner[focus]];
  const probe = services.find((x) => x !== depFocus);
  story.q({ text: `Which team owns ${focus} now? Use the team's current name.`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: owner[focus] } });
  story.q({ text: `Which services does the team \`${teamQ}\` own now?`, type: "set", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "whereEq", vars: ownerVars, value: teamQ, labels } });
  story.q({ text: `Which services does ${depFocus} depend on now?`, type: "set", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "members", var: deps[depFocus] } });
  story.q({ text: `How many direct dependencies does ${chain[0]} have now?`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "count", var: deps[chain[0]] } });
  story.q({ text: `Does ${depFocus} depend on \`${probe}\` now?`, type: "bool", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "contains", var: deps[depFocus], item: probe } });
  story.q({ text: `Who is the on-call engineer for ${watched[1]} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: oncall[watched[1]] } });
  story.q({ text: `In the initial specification, which team owned ${focus}? Use the name it had then.`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: owner[focus] } });

  if (p.compactAfter.length > 0) {
    story.cq({ text: `At this point, which team owns ${focus}?`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: owner[focus] } });
    story.cq({ text: `At this point, which services does ${depFocus} depend on?`, type: "set", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "members", var: deps[depFocus] } });
  }
  return { entities: services.length + pairs.length, depth: p.depth };
}
