// Ready-made tools and fastpaths. A file in the agent folder gives one its name:
//
//   // agent/tools/end_conversation.ts
//   import { endConversation } from "yap-bot/tools";
//   export default endConversation;
//
//   // agent/tools/web_search.ts
//   import { webSearch } from "yap-bot/tools";
//   export default webSearch({ searxngUrl: process.env.SEARXNG_URL! });
import { z } from "zod";
import { defineFastpath, defineTool } from "./define.ts";
import { spokenDuration } from "./services/timers.ts";
import * as acks from "./acks.ts";

/**
 * The user is wrapping up: ends the turn without another model round and, in wake mode, goes back
 * to waiting for the wake word. Tell the model when to call it in the instructions (see the template).
 */
export const endConversation = defineTool({
  description: "The user is done for now (thanks, that's it, no to anything else, never mind, stop): stop listening. Not when they said yes or okay to your question.",
  input: z.object({}),
  ack: false,
  final: true,
  execute(_, { sleep }) {
    sleep();
    return { ok: true };
  },
});

/** A countdown timer; it goes off in the room it was set in (voice.phrases.timerDone, or a timer_done trigger). */
export const setTimer = defineTool({
  description: "Start a countdown timer. It goes off in the room it was set in.",
  input: z.object({
    hours: z.number().min(0).optional(),
    minutes: z.number().min(0).optional(),
    seconds: z.number().min(0).optional(),
    name: z.string().optional().describe("What it's for, e.g. pasta"),
  }),
  execute({ hours = 0, minutes = 0, seconds = 0, name }, { timers, device }) {
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total <= 0) return { error: "the timer needs a length" };
    const t = timers.start({ seconds: total, name }, device);
    return { name: t.name, length: spokenDuration(total * 1000) };
  },
});

export const listTimers = defineTool({
  description: "List running timers, with the time left on each.",
  ack: acks.look,
  input: z.object({}),
  execute(_, { timers, device }) {
    const now = Date.now();
    return { timers: timers.list(device).map((t) => ({ name: t.name, left: spokenDuration(t.endsAt - now), room: t.room })) };
  },
});

export const cancelTimer = defineTool({
  description: "Cancel a timer by its name, or all of them.",
  input: z.object({ name: z.string().describe('The timer\'s name, or "all"') }),
  execute({ name }, { timers, device }) {
    if (!timers.list(device).length) return { cancelled: [], note: "no timers were running" };
    const cancelled = timers.cancel(name, device);
    if (!cancelled.length) return { error: `no timer called ${name}`, running: timers.list(device).map((t) => t.name) };
    return { cancelled: cancelled.map((t) => t.name) };
  },
});

/** "How much time is left?", answered at once without the model. */
export const timersLeft = defineFastpath({
  match: /^(how much time is left|how long is left|how much longer|how long left|time left)( on (the|my) timers?)?$/,
  run({ timers, device }) {
    const list = timers.list(device);
    if (!list.length) return "There aren't any timers running.";
    return list.map((t) => `${t.name === "timer" ? "Your timer" : `The ${t.name} timer`} has ${spokenDuration(t.endsAt - Date.now())} left.`).join(" ");
  },
});

/** "What time is it?", answered at once without the model. */
export const timeNow = defineFastpath({
  match: /^(what time is it|what's the time|whats the time|what is the time|time)( now| right now)?$/,
  run({ timezone }) {
    return `It's ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone })}.`;
  },
});

interface SearxResult {
  title: string;
  url: string;
  content?: string;
  publishedDate?: string | null;
}

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

/** Web search through a SearXNG instance (its JSON format must be enabled): direct answers, an infobox, the top 5 results. */
export function webSearch(o: { searxngUrl: string; language?: string; description?: string }) {
  return defineTool({
    description: o.description ?? "Search the web for current facts: news, opening hours, prices, anything recent.",
    input: z.object({
      query: z.string().min(2),
      time_range: z.enum(["day", "week", "month"]).optional().describe("Only for recent things: today's news (day), this week's (week)"),
    }),
    ack: acks.search,
    async execute({ query, time_range }, { signal }) {
      const q = new URLSearchParams({ q: query, format: "json", language: o.language ?? "en-US" });
      if (time_range) q.set("time_range", time_range);
      const r = await fetch(`${o.searxngUrl.replace(/\/$/, "")}/search?${q}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!r.ok) return { error: `search failed (${r.status})` };
      const data = await r.json();
      const results = ((data.results ?? []) as SearxResult[]).slice(0, 5).map((x) => ({
        title: x.title,
        site: site(x.url),
        snippet: (x.content ?? "").replace(/\s+/g, " ").slice(0, 300),
        published: x.publishedDate ? String(x.publishedDate).slice(0, 10) : undefined,
      }));
      // a direct answer or an infobox (Wikipedia/Wikidata summary) is often all a spoken reply needs
      const answers = ((data.answers ?? []) as (string | { answer?: string })[]).map((a) => (typeof a === "string" ? a : a.answer)).filter(Boolean).slice(0, 2);
      const infobox = (data.infoboxes ?? [])[0];
      const summary = infobox ? { title: infobox.infobox, text: String(infobox.content ?? "").slice(0, 500) } : undefined;
      // said plainly so the model reports a failed search instead of answering from memory
      if (!results.length && !answers.length && !summary) return { error: "the search found nothing; the search engines may be blocked right now" };
      return { answers: answers.length ? answers : undefined, summary, results };
    },
  });
}
