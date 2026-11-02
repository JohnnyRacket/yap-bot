// Speech to text through an OpenAI-compatible transcription endpoint (POST /audio/transcriptions):
// OpenAI, Groq, faster-whisper-server / speaches, LocalAI… These transcribe whole recordings, so the
// final text comes when the utterance ends. With partialEveryMs, the audio so far is also sent every
// so often for live words (more requests, but talking over a reply then interrupts it sooner).
// Runs in the hearing worker.
import type { SttFactory, SttStream } from "./types.ts";

export interface OpenAiSttOptions {
  /** e.g. https://api.openai.com/v1, http://whisper.lan:8000/v1 */
  baseUrl: string;
  /** e.g. whisper-1, gpt-4o-mini-transcribe, Systran/faster-whisper-small.en */
  model: string;
  apiKey?: string;
  /** ISO-639-1, e.g. "en": skips language detection. */
  language?: string;
  /** Words to expect (names, jargon), as Whisper's prompt. */
  prompt?: string;
  /** 0: final text only. Otherwise how often the audio so far is transcribed for live words. */
  partialEveryMs: number;
  timeoutMs: number;
}

/** PCM s16le mono 16 kHz in a WAV file. */
function wav(chunks: Float32Array[], samples: number, rate: number): Blob {
  const out = new DataView(new ArrayBuffer(44 + samples * 2));
  const str = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, samples * 2, true);
  let at = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, at += 2) out.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), true);
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

const create: SttFactory<OpenAiSttOptions> = (o, env) => {
  const url = `${o.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
  const transcribe = async (chunks: Float32Array[], samples: number, signal: AbortSignal) => {
    const form = new FormData();
    form.set("file", wav(chunks, samples, env.sampleRate), "speech.wav");
    form.set("model", o.model);
    form.set("response_format", "json");
    if (o.language) form.set("language", o.language);
    if (o.prompt) form.set("prompt", o.prompt);
    const res = await fetch(url, {
      method: "POST",
      headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs)]),
    });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return String(((await res.json()) as { text?: string }).text ?? "").trim();
  };
  const partialSamples = Math.round((o.partialEveryMs / 1000) * env.sampleRate);

  return {
    createStream(): SttStream {
      const chunks: Float32Array[] = [];
      let samples = 0;
      let sentAt = 0;
      let partial = "";
      let over = false;
      let inflight: AbortController | null = null;
      const stop = () => {
        over = true;
        inflight?.abort();
      };
      return {
        accept(w) {
          chunks.push(w.slice());
          samples += w.length;
          if (!partialSamples || inflight || samples - sentAt < partialSamples) return;
          sentAt = samples;
          const abort = (inflight = new AbortController());
          transcribe([...chunks], samples, abort.signal)
            .then((t) => void (over || (partial = t)))
            .catch(() => {}) // a missed partial is made up by the next one, or the final text
            .finally(() => void (inflight === abort && (inflight = null)));
        },
        text: () => partial,
        finish() {
          stop();
          return samples ? transcribe(chunks, samples, new AbortController().signal) : "";
        },
        close: stop,
      };
    },
  };
};

export default create;
