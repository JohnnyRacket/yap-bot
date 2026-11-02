// Ack banks: said while a tool runs, picked at random, skipping the last few said on that device.
// They play before the tool knows what it'll find, so they stay neutral. Give a tool one with
// `ack: acks.lookup`, or the voice a default with `acks: { tool: acks.action }`.

/** Fetching something from outside: weather, scores, prices. */
export const lookup = [
  "One sec.",
  "Let me check.",
  "Give me a sec.",
  "Just a moment.",
  "Let me see.",
  "Hang on.",
  "One moment.",
  "Let me find out.",
  "Pulling that up.",
  "Let me take a look.",
  "Checking.",
  "Bear with me.",
];

/** Searching the web. */
export const search = [
  "Looking that up.",
  "Let me look that up.",
  "Let me search for that.",
  "Let me find that.",
  "I'll look it up.",
  "Searching.",
  "Give me a sec.",
  "One sec.",
  "Let me find out.",
];

/** Reading the user's own things: timers, lists, accounts. */
export const look = ["Let me look.", "Let me see.", "One sec.", "Checking.", "Let me check.", "Just a sec.", "Let me take a look."];

/** Doing something: setting, changing, cancelling. The voice's default for tools without their own. */
export const action = ["Okay.", "Sure.", "On it.", "Got it.", "You got it.", "Will do.", "Alright.", "Sure thing."];
