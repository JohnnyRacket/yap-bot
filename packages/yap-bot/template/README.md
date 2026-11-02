# Yappy

A voice agent on [yap-bot](https://www.npmjs.com/package/yap-bot).

```sh
npm install
LLM_URL=http://localhost:8080/v1 LLM_MODEL=your-model npm run dev   # https://localhost:8450
npm run say -- "set a timer for ten minutes"                          # a typed turn, from another shell
npm run eval                                                          # does the model pick the right tools?
```

The first start downloads the speech models (~1 GB) into `~/.cache/yap-bot/models` (or `$MODELS_DIR`).

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
