# Yappy

A voice agent on [yap-bot](https://www.npmjs.com/package/yap-bot).

```sh
npm install
cp .env.example .env                              # set LLM_URL and LLM_MODEL (and your tools' secrets)
npm run dev                                       # https://localhost:8450
npm run say -- "set a timer for ten minutes"      # a typed turn, from another shell
npm run eval                                      # does the model pick the right tools?
```

The first start downloads the speech models (~1 GB) into `~/.cache/yap-bot/models` (or `$MODELS_DIR`).
Each turn is logged on one line: what was heard, the tools called (`name!` when one failed), what
was said, and how soon. Set `YAP_DEVICE_TOKEN` before the agent is reachable by anyone else: its
tools act on your accounts.

| Path | What |
|---|---|
| `agent/agent.ts` | name, model, wake word, timezone |
| `agent/instructions.md` | who it is and how it behaves |
| `agent/voice.ts` | speech in and out: engines, voice, speed, turn taking, interruptions |
| `agent/tools/<name>.ts` | `defineTool({ description, input, execute })` |
| `agent/skills/<name>.md` | instructions loaded when a request needs them |
| `agent/fastpaths/<name>.ts` | answered at once, without the model |
| `agent/schedules/<name>.md` | `cron:` + a prompt, said out loud |
| `agent/triggers/<name>.md` | webhooks, periodic checks and events |
| `agent/lib/` | your own helpers |
| `evals/cases.ts` | what people say → the tool that should be called |
