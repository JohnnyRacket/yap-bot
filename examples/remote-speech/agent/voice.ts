// Speech in and out from services elsewhere on the network, each optional: unset, the built-in
// in-process engine is used. Voice activity, turn detection and the wake word stay local (they're
// small, and they need every 32 ms of audio without a network hop).
//
//   WYOMING_STT=tcp://host:10300     wyoming-faster-whisper (Home Assistant's)
//   WHISPER_URL=http://host:8000/v1  any OpenAI-compatible /audio/transcriptions (WHISPER_MODEL, WHISPER_API_KEY)
//   SHERPA_WS=ws://host:6006         a sherpa-onnx streaming WebSocket server (live words)
//   WYOMING_TTS=tcp://host:10200     wyoming-piper (WYOMING_VOICE, default en_US-lessac-medium)
//   SPEECH_URL=http://host:8880/v1   any OpenAI-compatible /audio/speech, e.g. Kokoro-FastAPI (SPEECH_MODEL, SPEECH_VOICE)
import { defineVoice } from "yap-bot";
import { kokoro, nemotron, openaiSpeech, openaiTranscription, sherpaWebsocket, wyomingStt, wyomingTts } from "yap-bot/engines";

const env = process.env;

const stt = env.WYOMING_STT
  ? wyomingStt({ uri: env.WYOMING_STT, language: "en" })
  : env.WHISPER_URL
    ? openaiTranscription({
        baseUrl: env.WHISPER_URL,
        model: env.WHISPER_MODEL ?? "Systran/faster-whisper-base.en",
        apiKey: env.WHISPER_API_KEY,
        language: "en",
        // live words while you talk, so talking over a reply interrupts it sooner (one request a second)
        partialEveryMs: Number(env.WHISPER_PARTIAL_MS ?? 1000),
      })
    : env.SHERPA_WS
      ? sherpaWebsocket({ url: env.SHERPA_WS })
      : nemotron();

const tts = env.WYOMING_TTS
  ? { engine: wyomingTts({ uri: env.WYOMING_TTS }), voice: env.WYOMING_VOICE ?? "en_US-lessac-medium" }
  : env.SPEECH_URL
    ? { engine: openaiSpeech({ baseUrl: env.SPEECH_URL, model: env.SPEECH_MODEL ?? "kokoro" }), voice: env.SPEECH_VOICE ?? "af_heart", speed: 1.2 }
    : { engine: kokoro(), voice: "af_heart", speed: 1.3 };

export default defineVoice({ stt, tts, interruptions: { minWords: 2 } });
