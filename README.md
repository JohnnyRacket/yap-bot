# yap-bot 🗣️

Declarative local voice agents. Streaming conversation in the style of Pipecat (end-of-turn
detection, interruptions, speech streamed as it's written) plus a folder-based agent definition:
tools, skills, fastpaths, schedules and triggers are files, and the path is the name. TypeScript on
Node 24. Your agent's files run as they are, with no build step.

```
 devices (WebSocket)          yap-bot server                                          your services
 web page, Pis, …    ◀──▶  VAD → speech to text → end of turn                          any OpenAI-compatible LLM
                           → fastpaths / agent loop (tools, skills) → sentences → TTS ─▶ (llama.cpp, vLLM, OpenAI…)
                           timers · schedules · triggers · announcements · per-device history
```

Every speech part is a swappable engine, and speech in and out can come from services on other
machines (Wyoming / Home Assistant, OpenAI-compatible, sherpa-onnx servers). The defaults all run in
process on a CPU:
**Nemotron Speech Streaming** (speech to text, 160 ms chunks), **Silero** (voice activity),
**Smart Turn v3** (end of turn), a **sherpa-onnx zipformer** keyword spotter (wake word, also run on
the device in WebAssembly) and **Kokoro 82M** (speech).

## Start an agent

```sh
npx yap-bot init my-agent && cd my-agent
npm install
LLM_URL=http://localhost:8080/v1 LLM_MODEL=your-model npm run dev    # https://localhost:8450
```

The first start downloads the speech models (~1 GB) into `~/.cache/yap-bot/models`, shared by every
agent on the machine (`MODELS_DIR` puts them elsewhere; a `./models` folder is used when present).
Open the page, click through the self-signed certificate warning (browsers only allow the
microphone over HTTPS), and talk. Or type, from another shell:

```sh
npm run say -- "set a pasta timer for ten minutes" "how much time is left"
npm run eval                      # does the model call the right tools? (evals/cases.ts)
```

## The agent folder

Editing a file reloads the agent live (helpers in `agent/lib/` included); a file that doesn't load
is reported with its name and line, and the previous version keeps running. Engine and wake
keyword settings, and `.env`, need a restart; the server says so for the first two.

| Path | What |
|---|---|
| `agent/agent.ts` | `defineAgent({ name, model, wake, followUpMs, timezone, historyMessages, historyChars, maxToolRounds, prompt, ui, apiSecret, deviceToken })` |
| `agent/instructions.md` | The always-on prompt (or `instructions/*.md`) |
| `agent/voice.ts` | `defineVoice({ stt, vad, turn, wake, tts, interruptions, acks, phrases, hooks })`, optional |
| `agent/tools/<name>.ts` | `defineTool({ description, input: z.object(…), execute(input, ctx), ack?, final? })`. `final` ends the turn after the tool runs |
| `agent/skills/<name>.md` | A procedure loaded on demand. Frontmatter: `description`, optional `keywords` (preloaded when those words appear) |
| `agent/fastpaths/<name>.ts` | `defineFastpath({ match, run })`: answered at once, no model |
| `agent/schedules/<name>.md` | Frontmatter `cron` (+ `room`, `speak`) and a prompt; or `defineSchedule({ cron, run })` |
| `agent/triggers/<name>.md` | Frontmatter `webhook: true` / `every: 5m` / `event: timer_done` (+ `room`, `secret_env`, `announce: true`) and a prompt or text; or `defineTrigger({ on, run \| prompt \| announce })` |
| `agent/lib/` | Your own helpers. `store("name")` gives a persistent key-value store |

```ts
// agent/tools/flip_coin.ts
import { defineTool, z } from "yap-bot";

export default defineTool({
  description: "Flip a coin.",
  input: z.object({}),
  execute: () => ({ coin: Math.random() < 0.5 ? "heads" : "tails" }),
});
```

A tool's `ctx` has `device` (id, room), `timezone`, `timers`, `store`, `say()` (speak mid-turn),
`announce()` (speak in a room or everywhere), `sleep()` (back to waiting for the wake word after
this turn), `signal` (aborted on interruption or timeout: pass it to `fetch`) and `log()`. A tool
gets 20 s (`timeoutMs` to change it); a turn gets 6 model rounds (`maxToolRounds` in the agent).
What a tool returns goes back to the model as JSON; throw, or return `{ error }`, and the model is
told what went wrong. Secrets for tools go in `.env`, read as `process.env.NAME`.

**Ready-made** in `yap-bot/tools` (a one-line file gives each its name):
`endConversation`, `setTimer`, `listTimers`, `cancelTimer`, `webSearch({ searxngUrl })`, and the
fastpaths `timeNow` and `timersLeft`. Ack banks: `acks.lookup`, `acks.search`, `acks.look`, `acks.action`.

```ts
// agent/tools/end_conversation.ts
import { endConversation } from "yap-bot/tools";
export default endConversation;
```

Keep the tool list short (under ~15) and each tool's schema small, because a small model picks
worse past that. A tool with a long enum and long descriptions can make the model fail unrelated
cases. Check new tools with `npm run eval`. Where every action takes the same arguments, split a
read tool from a change tool that has an `action` (`read_list` / `change_list`).

**Triggers** make the agent act outside a conversation. **Webhooks**: `POST /hooks/<name>` (JSON or
text body, available as `{{payload}}` / `{{payload.field}}`; with `secret_env`, send
`Authorization: Bearer <secret>`, or `?token=`). Only POST: a link or an image can't fire one.
A webhook without a secret that puts its payload in a prompt is warned about at load: anyone on
the network could have the agent do things with your tools. A webhook with `respond: true`
(frontmatter, or `webhook: { respond: true }`) waits for the trigger and answers with what `run()`
returned, or a prompt's reply instead of announcing it; others answer 202 at once. **Every**:
periodic checks, with a `store` for spotting changes. The first run comes one interval after start
unless `at_start: true` (`atStart`) runs it once when the server starts as well (not on reloads).
**Events**: `timer_done` (replaces the built-in "your timer is done"), `device_connected`, `device_disconnected`.

**`POST /api/ask`** `{"text": "…", "room": "kitchen"}` runs one typed turn (tools run for real) and
answers with the reply and the tool calls. It needs `Authorization: Bearer <apiSecret>` (default
`$YAP_API_SECRET`).

## Running, configuring, securing

`yap-bot dev` and `start` read `./.env` (variables set in the shell win); `yap-bot init` adds a
`.env.example`. Each turn is logged on one line: what was heard, the tools called (`name!` when
one failed, with the error logged above it), what was said, and how soon the first sound came.
`DEBUG=1` logs more.

**Who can talk to it.** Without a device token, anyone who can reach the port can talk to the
agent and so run its tools. Set `YAP_DEVICE_TOKEN` (or `deviceToken` in the agent): devices must
present it. The web page asks for it once and remembers it, or open it once as
`https://host:8450/#token=…`; `yap-bot say` takes `--token`. Webhooks have their own secrets
(`secret_env`), and `/api/ask` its `apiSecret`.

## Patterns

**A login that survives edits.** Editing a file re-imports the agent folder, so a module's own
variables start over. `shared(name, init)` makes a value once per server: a logged-in session, a
cookie jar, a client.

```ts
// agent/lib/library.ts
import { shared } from "yap-bot";
export const session = shared("library", () => ({ cookie: "", until: 0 }));

export async function loggedIn(signal: AbortSignal) {
  if (Date.now() < session.until) return session.cookie;
  // log in with process.env.LIBRARY_CARD / LIBRARY_PIN (from .env), keep the cookie for an hour
  …
}
```

**Per-person state.** A tool's `store` is shared by every device; key by `device.id` for what's
one person's ("where we got to in the list"). Turns from schedules, triggers and `/api/ask` run as
device `schedule` in room `all`/`api`. `store` writes plain JSON under `data/store/`: fine for a
cursor or a preference, not for passwords (keep those in `.env`). A store notices when its file is
changed by something else (a script, an edit by hand) and reads it again.

**Confirm before doing something that can't be undone.** Give the tool a `confirmed` argument and
say in its description to call it with `confirmed: false` first; return what *would* happen, so the
model asks ("Cancel your hold on Piranesi?"), and act only when called again with `confirmed: true`
after a yes. Add an eval case for each step.

**When something needs setting up.** A tool that can't work yet (an account not connected, a login
expired) should say so in words the model can pass on, including that it isn't done by voice ("That's
set up in the settings, not by voice"); otherwise the model offers to "connect it" and can't. Throw
an `Error` with that message, or return `{ error }`. The voice rules also tell the model to offer only
what its tools can do.

**Finishing after the turn.** A tool can start something that takes longer than the turn (waiting for
the user to enter a code on their phone, a slow export) and return at once with what to say; when
it's done, `ctx.announce(text, { room: ctx.device.room })` speaks the outcome in that room.

**Reading out codes and numbers.** Speech reads "52541470" as a number. Return `spokenDigits(code)`
("5 2 5 4, 1 4 7 0") from the tool and the model says it digit by digit.

**Write descriptions about "the user".** Tool descriptions and results are read by the model while
it talks *to* the person; "her holds" makes it say "her" to her face. "The user's holds" or "their
holds" don't.

**Misheard names.** Speech to text gets book titles, people and places wrong. Match what was said
against the list the tool has (holds, contacts, rooms) by letter pairs, not exact words, and say
the real name back so a wrong match is caught.

**Long answers.** The voice rules ask for one to three sentences unless more is asked for, and
`maxTokens` caps a reply. For a long list, return the first few with a count ("5 of 12") and a way
to get the next ones, and say in the instructions to read a few, then offer more. Tool results
over 2000 characters are cut short in the history (the turn itself sees them whole), and the
history is trimmed by size (`historyChars`) as well as count.

## Testing an agent

- `npm run say -- "…"`: typed turns against the running agent, tools run for real.
- `npm run eval`: what people say → the tool the model calls, from `evals/cases.ts` (nothing runs).
- `yap-bot/testing`: `TestClient`, a headless device for your own scripts (text or audio in, every
  event out), and `speech()` for synthetic speech.
- `yap-bot eval` exits non-zero when a case fails, for CI.

## The model

`model` is any OpenAI-compatible chat endpoint with tool calls: `baseUrl`, `id`, `apiKey`
(defaults `$LLM_URL`, `$LLM_MODEL`, `$LLM_API_KEY`), `temperature`, `maxTokens`, `thinking` (sent
as `chat_template_kwargs.enable_thinking` when set; turn it off for thinking models) and
`extraBody`. For anything else, give it `complete(req)`, which streams text through
`req.onText` and returns the tool calls.

The prompt is ordered unchanging → changing (instructions, voice rules, skills index, tools,
history, then the per-turn context line and words) so llama.cpp reuses its cache. `prompt.voiceRules`
(how to talk out loud) and `prompt.context` (the `[date · room]` line) can be replaced.

## Voice and engines

```ts
import { defineVoice } from "yap-bot";
import { nemotron, sherpaStt, silero, smartTurn, sherpaKws, kokoro, openaiSpeech, wyomingStt } from "yap-bot/engines";

export default defineVoice({
  stt: nemotron({ threads: 2 }),        // or sherpaStt({ model: "<sherpa-onnx streaming transducer>" })
  vad: silero(),
  turn: { detector: smartTurn(), threshold: 0.5, pauseMs: 200, incompleteWaitMs: 1500 },  // detector: false → silence decides
  wake: { spotter: sherpaKws() },       // false → only the transcript wakes it
  tts: { engine: kokoro({ threads: 4 }), voice: "af_heart", speed: 1.3, ackSpeed: 1.1 },
  // tts: { engine: openaiSpeech({ baseUrl: "http://kokoro:8880/v1" }), voice: "af_heart", speed: 1.2 },
  // stt: wyomingStt({ uri: "tcp://whisper.lan:10300" }),   speech services elsewhere: see below
  interruptions: { minWords: 2, pauseOnSpeech: true },
  acks: { tool: ["Okay.", "Sure."] },
  phrases: { error: "Sorry, something went wrong.", noAnswer: "…", timerDone: (t) => "…" },
});
```

**Voices a device can pick.** `tts.voices` lists voices offered in each device's Settings, in the
order shown; a device's pick is used for everything it hears, announcements too, and the default
voice is always on the list. `kokoroVoiceChoices({ minGrade?, gender? })` from `yap-bot/engines`
gives Kokoro's English voices best first, by its authors' grades ("Michael · American man · C+"); or
list your own as ids or `{ id, label }`. Each offered voice is downloaded at start, and its acks are
made ready the first time a device picks it.

```ts
tts: { voice: "am_michael", voices: kokoroVoiceChoices({ minGrade: "C" }) },
```

### Speech services elsewhere

Speech to text and speech can each come from a service on another machine instead: a GPU box,
a Home Assistant setup, a cloud API. Voice activity, turn detection and the wake word stay local:
they're small, and they need every 32 ms of audio without a network hop.

| Engine | Talks to | Live words while you talk |
|---|---|---|
| `wyomingStt({ uri: "tcp://host:10300" })` | Wyoming speech to text: wyoming-faster-whisper and the others Home Assistant uses | if the server streams them |
| `openaiTranscription({ baseUrl, model, apiKey?, partialEveryMs? })` | `POST /audio/transcriptions`: OpenAI, Groq, faster-whisper-server / speaches, LocalAI | with `partialEveryMs` (re-sends the audio so far) |
| `sherpaWebsocket({ url: "ws://host:6006" })` | a sherpa-onnx streaming WebSocket server (e.g. Nemotron on a bigger machine) | yes |
| `wyomingTts({ uri: "tcp://host:10200" })` | Wyoming speech: wyoming-piper and others. `tts.voice` is the server's voice name; speed is set on the server | |
| `openaiSpeech({ baseUrl, model?, apiKey? })` | `POST /audio/speech` streaming PCM: Kokoro-FastAPI, OpenAI | |

Audio streams to Wyoming and sherpa servers while you talk, over a connection per utterance, so
only the last bit is left to decode when you stop. A batch service (`openaiTranscription`)
transcribes the whole utterance when you stop. On a CPU-only box that took 0.75–1.4 s with
Whisper base, against an instant final with a streaming engine. Without live words, talking over
a reply interrupts it once your words are transcribed rather than as you say them. Live words
from `partialEveryMs` cost the service a request each time and can delay the final text a little.
If a service fails, the turn goes on with the live words heard so far, and the error is logged.
`examples/remote-speech` picks each service from an environment variable.

**Your own engine.** Hearing runs in worker threads, so a hearing engine is named by a module
whose default export creates it (interfaces in `yap-bot/engines`: `SttEngine`, `VadEngine`,
`TurnEngine`, `KwsEngine`):

```ts
// agent/engines/my-stt.ts
import type { SttFactory } from "yap-bot/engines";
const create: SttFactory<{ language: string }> = async (options, env) => ({
  createStream: () => ({ accept(samples) { … }, text: () => "…", finish: (trailingSilence) => "…" }),
});
export default create;

// agent/voice.ts
stt: { name: "my-stt", module: new URL("./engines/my-stt.ts", import.meta.url).href, options: { language: "en" } },
```

A speech engine (`TtsEngine`) runs on the main thread: `tts: { engine: { name, create: (env) => myEngine } }`.
It may produce any sample rate (`sampleRate`) and is resampled to the devices' 24 kHz. A spec's
`downloads` lists model files for `yap-bot models` to fetch.

## How a turn works

1. Mic audio (16 kHz) → **VAD** finds speech → **speech to text** transcribes while you talk.
2. At a 200 ms pause the **turn detector** (own thread) judges the last 8 s of audio: complete ends
   the turn; incomplete waits for more speech, at most 1.5 s.
3. **Fastpaths** first; otherwise the **agent loop**: the model streams text, calling tools one
   round at a time. As soon as a tool call's name streams in (~0.5 s, before its arguments are
   written), its **ack** is said ("Let me check.") unless something was said already. Acks are
   picked at random while skipping the last 4 said on that device, and the reply's own leading
   "OK," is then dropped. Acks and other short phrases are kept as ready-made audio, so tool turns
   make a first sound in ~0.6–1 s.
4. Text is cut into sentences. Each is spoken by the **TTS engine** and streamed to the device.
5. The device reports playback. **Talking over it** (`interruptions.minWords`) cancels everything
   in flight, and tool calls not yet made aren't. The history keeps only what was actually heard,
   plus every tool result (a call cut off gets a result saying so).

Modes, per device: **push** to talk, **open** mic, **wake** word (then a follow-up window,
`followUpMs`, cut short when the model calls `end_conversation`).

### Where the wake word is heard

| Detector | Runs on | Audio sent while asleep |
|---|---|---|
| `device` (the web client's default) | the device: the same keyword spotter, as WebAssembly in a worker | **none**. On a hit the device sends `wake`, then its audio from 0.8 s before the hit, then live audio until it's told it's asleep again |
| `keyword` | the server's keyword spotter | all of it |
| `transcript`, `both` | the transcript (and the spotter, for `both`) | all of it |

A wake word of your own needs its keyword spotter tokens (`wake.keywords`, see `WakeWord` in the
types). Without them only the transcript detector can wake the agent.

## Deploying

`yap-bot init` adds `deploy/Dockerfile`: the default models get their own layer, and data lives in
the `/data` volume. `.env` isn't copied into the image: give the container its settings and secrets
(`docker run --env-file .env`, or `env_file:` in compose). Environment: `LLM_URL`, `LLM_MODEL`,
`LLM_API_KEY`, `PORT` (8450), `AGENT_DIR`, `DATA_DIR`, `MODELS_DIR`, `WEB_DIR`, `TLS=off`,
`TLS_CERT`/`TLS_KEY`, `TLS_NAMES` (the names devices use to reach it: the self-signed certificate
is made for them, and inside a container it otherwise names the container), `WATCH=0`,
`YAP_DOWNLOAD=0`, `YAP_DEVICE_TOKEN`, `YAP_API_SECRET`, `TZ`. Under `yap-bot start` the process
exits if hearing stops working, so a restart policy brings it back.

Phones: browsers only allow the microphone over HTTPS. Android Chrome accepts the self-signed
certificate after the warning; iOS Safari has been unreliable with self-signed certificates for
WebSockets, so test early, and if it fails give it a real certificate (`TLS_CERT`/`TLS_KEY` from
mkcert, or put it behind a reverse proxy such as Caddy). The page asks for a tap before it can make
sound (browsers require it), keeps the screen on while listening, and hides tool calls and timings
unless Settings → Show details is on (or the page is opened with `?debug`). `ui: { details: true }`
in the agent turns them on for devices that haven't chosen, handy while building one.

From code: `const { port, close } = await start({ agentDir, port: 0 })` from `yap-bot/server`.

## This repo

```sh
npm install
npm run build        # the web client → packages/yap-bot/web (the page dev serves), the package → dist
npm run dev          # the template agent (packages/yap-bot/template), from source
npm run typecheck
npm test             # unit tests, and a whole server with fake speech engines and a mock LLM (no models)
npm run speak-test   # synthetic speech in, timings and an interruption test out (YAP_URL=…)
node --conditions=yap-bot-src scripts/wake-latency.ts "Computer, what time is it?"
```

`packages/yap-bot` is the published package. The CLI runs its TypeScript directly from a checkout
(the `yap-bot-src` export condition) and its built `dist/` once installed from npm. A project can
depend on a checkout with `"yap-bot": "file:../yap-bot/packages/yap-bot"`.
`packages/client-web` is the device page, built into the package. Its keyword spotter is
sherpa-onnx's npm package with two small patches applied in `vite.config.ts`. Keep `sherpa-onnx`
(client-web) and `sherpa-onnx-node` (runtime) on the same version.
