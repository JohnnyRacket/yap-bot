import { defineVoice } from "yap-bot";
// import { nemotron, silero, smartTurn, sherpaKws, kokoro, openaiSpeech } from "yap-bot/engines";

// Every setting has a default; these are some you may want to change. Engines are swappable:
//   stt: nemotron({ threads: 2 })                      speech to text (or sherpaStt({ model }) for another language)
//   vad: silero()                                      voice activity
//   turn: { detector: smartTurn() }                    end of turn (false: silence alone decides)
//   wake: { spotter: sherpaKws() }                     wake word spotting (false: transcript only)
//   tts: { engine: kokoro({ threads: 4 }) }            or openaiSpeech({ baseUrl, model, apiKey })
// or an engine of your own (see EngineSpec and TtsSpec in yap-bot/engines).
export default defineVoice({
  // Kokoro voices: af_heart af_bella af_nicole am_michael am_fenrir bf_emma bm_george
  tts: { voice: "af_heart", speed: 1.3, ackSpeed: 1.1 },
  // words heard before talking over it interrupts it (1 is fine with echo cancellation)
  interruptions: { minWords: 2 },
});
