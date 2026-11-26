// Name pools and noise templates. Plain data. Noise never names a tracked subject, never holds a tag word of a
// stage prompt, and never states a decision.

export const PEOPLE = [
  "Ana", "Bo", "Chen", "Dara", "Eli", "Femi", "Gus", "Hana", "Ivo", "Jun", "Kira", "Lars", "Mei", "Nils",
  "Oona", "Pita", "Quinn", "Rosa", "Sami", "Tove", "Uma", "Vik", "Wren", "Yara", "Zed",
];

export const NOISE_AREAS = [
  "docs site", "lint config", "design tokens", "onboarding wiki", "status page", "release notes", "office wifi",
  "build cache", "CI runners", "test fixtures", "storybook", "changelog bot", "dependabot", "code owners file",
  "sprint board", "retro notes", "team calendar", "brand assets", "help center", "error pages",
];

export const NOISE_FILES = [
  "README.md", "docs/style.md", "scripts/lint.sh", ".editorconfig", "assets/logo.svg", "docs/faq.md",
  "tools/fmt.mjs", "ci/cache.yml", "docs/glossary.md", "web/favicon.ico", "notes/retro.md", "docs/howto.md",
];

export const NOISE_BOTS = ["ci-bot", "lint-bot", "docs-bot", "cache-bot", "chat-relay", "calendar", "metrics"];

/**
 * Noise templates. Placeholders: {person} {person2} {area} {file} {bot} {n} {m} {pct} {hh} {mm}.
 * `short` templates go to notes and small feeds. `long` templates are verbose log lines for the large feed.
 */
export const NOISE_SHORT = [
  "{person} fixed a typo in {file}.",
  "The {area} got a new page; nobody needs to act on it.",
  "{person} asked whether the {area} meeting moves; it stays on Thursday.",
  "Lint warnings in {file} dropped from {m} to {n}.",
  "{person} and {person2} paired on the {area} for {n} minutes.",
  "Reminder: the {area} review is optional this week.",
  "{bot} posted the weekly digest ({n} items, none urgent).",
  "{person} shared a screenshot of the {area}; it looks fine.",
  "The {area} build took {n} seconds, about the same as last week.",
  "{person} will be out on Friday; {person2} covers chat questions.",
  "Somebody renamed a channel about the {area}; no action needed.",
  "{person} suggested better emoji for the {area} channel.",
  "Cache hit rate on {file} checks is {pct} percent.",
  "{person} cleaned up {n} stale branches.",
  "The {area} poll closed with {n} votes for the blue theme.",
  "{bot} rotated its own log file at {hh}:{mm}.",
  "{person} moved the {area} doc into the archive folder.",
  "Coffee order for the {area} sync: {n} lattes.",
  "{person} confirmed that {file} is formatted.",
  "A flaky test in the {area} passed on rerun.",
  "{person} updated the alt text of {n} images in the {area}.",
  "The {area} dashboard refreshed; the numbers look normal.",
];

export const NOISE_LONG = [
  "{bot}: job #{n}{m} finished status=ok duration={n}.{m}s cache=warm artifacts={m} warnings=0 runner=pool-{n} note=routine nightly sweep of the {area}, nothing to report",
  "{bot}: heartbeat seq={n}{m} queue_depth={m} oldest_item_age={n}s workers={m} cpu={pct}% mem={pct}% area=\"{area}\" outcome=nominal, no operator action",
  "{bot}: {person} opened a chat thread about the {area}; replies={n}; summary=\"small wording questions, resolved in thread\"; follow_up=none",
  "{bot}: scan of {file} complete files_checked={n}{m} issues_new=0 issues_closed={m} duration={n}s; trend flat compared with the previous {n} runs",
  "{bot}: calendar sync imported {n} events for the {area}; conflicts=0; reminders_sent={m}; the import window covered the next {m} days",
  "{bot}: dependency audit of the {area} tooling found {m} minor updates; none are security related; the bot will open grouped updates later",
  "{bot}: build {n}{m} for the {area} reused {pct}% of cached layers; image size unchanged; upload time {n}s; retention policy applied to {m} old images",
  "{bot}: {person} edited {file} (+{n} -{m} lines, formatting only); review not required by policy; merged after the standard wait",
  "{bot}: metrics rollup for the {area}: p50={n}ms p95={m}{n}ms errors=0 sample={n}{m} requests; values inside the usual band for this hour",
  "{bot}: link checker visited {n}{m} pages of the {area}; broken=0; redirected={m}; slowest page answered in {n}{m}ms",
  "{bot}: {person} and {person2} booked the small room for the {area} chat at {hh}:{mm}; duration {n} minutes; no agenda attached",
  "{bot}: cleanup removed {m} temp folders under {file} freed {n}{m} MB; next cleanup scheduled; disk usage at {pct}% of quota",
];

// ---- Bulk material (v2). Multi-line routine records. Same rules: no tracked subject, no tag, no decision. ----

export const NOISE_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const NOISE_TOOLS = ["docs-builder", "link-checker", "markdown-lint", "image-optimizer", "spellcheck", "chat-relay"];

/**
 * Noise genres for notes, tickets and small feeds. A record is the head line plus some lines of the body pool, in
 * pool order. Extra placeholders: {person3} {day} {num} {ver} {tool}.
 */
export const NOISE_GENRES = [
  {
    head: "Standup notes from {person}:",
    pick: [3, 5],
    body: [
      "- yesterday: tidied the {area} pages and answered {n} questions in chat",
      "- yesterday: reviewed {n} small pull requests about the {area}",
      "- today: pairing with {person2} on {file}",
      "- today: rewriting the intro paragraph of the {area} guide",
      "- blockers: none",
      "- out early on {day} for a dentist visit",
      "- updated the screenshots in {file}",
      "- will demo the new {area} layout next week",
    ],
  },
  {
    head: "Review thread on {file} ({n} comments):",
    pick: [3, 5],
    body: [
      "{person}: please wrap this paragraph at {m} characters.",
      "{person2}: done, and I fixed the heading levels too.",
      "{person}: the table in section {n} renders badly on small screens.",
      "{person3}: nit: trailing spaces on line {m}.",
      "{person}: can we move the long examples to an appendix?",
      "{person2}: moved them; the page is {pct} percent shorter now.",
      "{person3}: approved, merge when the checks are green.",
    ],
  },
  {
    head: "Read-only export of the {tool} configuration for the {area}:",
    pick: [4, 7],
    body: [
      "  max_line_length = {m}{n}",
      "  theme = \"slate-{n}\"",
      "  cache_hours = {n}",
      "  runner_pool = \"pool-{n}\"",
      "  notify_channel = \"#team-chat\"",
      "  keep_reports_days = {m}",
      "  preview_pages = true",
      "  ignore_paths = [\"drafts/\", \"tmp/\"]",
      "  report_format = \"text\"",
    ],
  },
  {
    head: "{bot} run {n}{m} summary:",
    pick: [3, 6],
    body: [
      "  step checkout ok ({n}.{m}s)",
      "  step lint ok, {m} files",
      "  step docs-build ok, {m} pages",
      "  step upload ok, {n}{m} KB",
      "  step notify ok, channel team-chat",
      "  cache restore hit rate {pct}%",
      "  total duration {n}m {m}s, no warnings",
    ],
  },
  {
    head: "Notes from the {area} sync on {day}:",
    pick: [3, 5],
    body: [
      "{person} showed the new layout of the {area}.",
      "{person2} asked for a darker header; {person} will try two variants.",
      "The group will look at the {area} again in {n} weeks.",
      "{person3} said that the office printer works again.",
      "Nothing in this sync touches the project itself.",
      "{person2} shared a short survey; {n} people answered so far.",
    ],
  },
  {
    head: "Ticket DOC-{num}: broken anchors on a help page",
    pick: [3, 4],
    body: [
      "Reporter: {person}. Priority: low.",
      "The page {file} has {n} broken anchors after the last rename.",
      "{person2} will fix it after the {area} work.",
      "Status: open, no due date.",
      "Related: a similar report from {day} was closed as a duplicate.",
    ],
  },
  {
    head: "Chat excerpt from #team-chat:",
    pick: [3, 5],
    body: [
      "{person}: is anyone else seeing the slow {area} page?",
      "{person2}: yes, it is the image cache, it clears itself after {n} minutes",
      "{person}: ok, thanks",
      "{person3}: lunch at {hh}:{mm}? the new place near the station",
      "{person2}: count me in",
      "{person}: reminder that the {area} poll closes on {day}",
    ],
  },
  {
    head: "Calendar update from {bot}:",
    pick: [2, 4],
    body: [
      "- the {area} demo moves to {hh}:{mm} on {day}",
      "- room booking for the {area} retro is confirmed",
      "- {person} is on leave from {day} for {n} days",
      "- the all-hands slides are due on {day}",
      "- {person2} hosts the next lunch talk about typography",
    ],
  },
  {
    head: "{bot} weekly numbers for the {area}:",
    pick: [3, 5],
    body: [
      "  page views {n}{m}{n}",
      "  median load {n}{m} ms",
      "  error rate 0.0{n} percent",
      "  uptime 99.9{n} percent",
      "  searches without a result: {m}",
      "  the numbers are inside the usual band",
    ],
  },
  {
    head: "{bot} opened a grouped update for the {area} tooling:",
    pick: [3, 5],
    body: [
      "  - markdown-lint {ver} to {ver}",
      "  - link-checker {ver} to {ver}",
      "  - image-optimizer {ver} to {ver}",
      "  - spellcheck dictionary {ver} to {ver}",
      "  The checks passed. No reviewer is assigned yet.",
    ],
  },
  {
    head: "Retro notes of the {area} group:",
    pick: [3, 4],
    body: [
      "Went well: {person} cleared the docs backlog.",
      "Went well: the {area} pages load faster.",
      "To improve: shorter standups on {day}.",
      "Action: {person2} books a room for the next retro.",
      "Action: {person3} collects ideas for the team offsite.",
    ],
  },
  {
    head: "Style guide excerpt, section {n}.{n}:",
    pick: [3, 5],
    body: [
      "Use sentence case for headings.",
      "Keep tables under {n} columns.",
      "Write numbers below ten as words in running text.",
      "Link to the glossary at the first use of a term.",
      "Put one idea in each paragraph.",
      "Name the button exactly as the screen shows it.",
    ],
  },
];

/** Detail lines that follow a verbose log record in a large feed. */
export const NOISE_LOG_DETAILS = [
  "worker=pool-{n} attempt=1 result=ok",
  "note: routine, no operator action",
  "upstream=status-page latency={n}{m}ms",
  "retention applied to {m} items",
  "trace=t-{num}{m} span_count={m} dropped=0",
  "owner=docs-team escalation=none",
  "next_run=in {n}h window={hh}:{mm}",
];

/**
 * Neutral context lines for state records, by delivery kind. They hold no tracked subject or value. One or two of
 * them follow the line that holds the event.
 */
export const RECORD_CONTEXT = {
  minutes: ["Raised in the {area} sync; attendees: {person}, {person2} and {person3}.", "Action owner for the follow-up: {person}.", "Minuted by {person2}."],
  ticket: ["Comment by {person} on ticket OPS-{num}.", "Watchers: {person2}, {person3}.", "Linked from the {area} board by {person}."],
  review: ["Thread started by {person}; {person2} replied with a thumbs-up.", "Review round {n}, reviewer {person3}."],
  notes: ["Written down by {person} after a call with {person2}.", "Shared in the {area} channel at {hh}:{mm}."],
  journal: ["Entry added to the change journal by {person}.", "Countersigned by {person2}."],
  design: ["From the design discussion led by {person}.", "{person2} and {person3} were in the discussion."],
  log: ["source={bot} level=info actor={person}", "request_id=r-{num}{m}"],
  chat: ["{person2} reacted with a thumbs-up", "thread replies: {n}"],
  board: ["card updated by {person}", "card id {num}"],
  ci: ["pipeline note added by {person}", "pipeline {num}{m}"],
};

/**
 * Common English words that must never be a value: a value of that kind reads as part of the sentence (for example
 * the locale code "it" in "Approved: it joins the supported locales"). The generator rejects any option or event
 * value in this list, compared without case.
 */
export const COMMON_WORDS = new Set(
  (
    "a an the it its is are was were be been am i me my mine we us our you your he him his she her they them their " +
    "this that these those to of in on at by for from with as or and but nor not no yes so if then than up down out " +
    "off over under into onto via per all any some none each both few more most less other such only own same too " +
    "very can will just now new old one two three ok set get put use run see go do does did has had have may might " +
    "must shall should would could what which who whom whose why how when where there here also again once ever " +
    "never always rest open close done yes true false null nil none default auto"
  ).split(" "),
);
