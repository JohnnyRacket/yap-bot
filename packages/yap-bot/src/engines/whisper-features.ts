// Whisper-style log-mel features for Smart Turn v3: a port of Pipecat's numpy implementation
// (pipecat/audio/turn/smart_turn/_whisper_features.py, BSD-2-Clause, itself derived from
// Hugging Face transformers' WhisperFeatureExtractor, Apache-2.0).
//
// Input: 8 s of 16 kHz audio (128000 samples). Output: Float32Array of shape [80, 800], mel-major.

const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const SR = 16000;
export const SMART_TURN_SAMPLES = SR * 8;
export const N_FRAMES = 800;
const N_BINS = N_FFT / 2 + 1;

const hzToMel = (f: number) => (f >= 1000 ? 15 + Math.log(f / 1000) * (27 / Math.log(6.4)) : (3 * f) / 200);
const melToHz = (m: number) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 * m) / 3);

/** Slaney-normalized triangular filters, [N_MELS][N_BINS]. */
const MEL_FILTERS: Float64Array[] = (() => {
  const melMin = hzToMel(0);
  const melMax = hzToMel(SR / 2);
  const filterFreqs = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1)));
  const fftFreqs = Array.from({ length: N_BINS }, (_, i) => ((SR / 2) * i) / (N_BINS - 1));
  const out: Float64Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float64Array(N_BINS);
    const enorm = 2 / (filterFreqs[m + 2] - filterFreqs[m]);
    for (let b = 0; b < N_BINS; b++) {
      const down = -(filterFreqs[m] - fftFreqs[b]) / (filterFreqs[m + 1] - filterFreqs[m]);
      const up = (filterFreqs[m + 2] - fftFreqs[b]) / (filterFreqs[m + 2] - filterFreqs[m + 1]);
      row[b] = Math.max(0, Math.min(down, up)) * enorm;
    }
    out.push(row);
  }
  return out;
})();

/** Periodic Hann window (matches np.hanning(N + 1)[:-1]). */
const HANN = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT));

// Mixed-radix Cooley-Tukey FFT for N = 400 = 2^4 * 5^2, recursive on the smallest prime factor.
function smallestFactor(n: number): number {
  for (let p = 2; p * p <= n; p++) if (n % p === 0) return p;
  return n;
}

// per transform size: its factor, twiddles cos/sin(-2πjk/n) laid out [j * n + k], and scratch
// buffers for the p sub-transforms (each level of the recursion has a distinct size, so reuse is safe)
interface Stage { p: number; m: number; cos: Float64Array; sin: Float64Array; subRe: Float64Array[]; subIm: Float64Array[] }
const stages = new Map<number, Stage>();
function stage(n: number): Stage {
  let s = stages.get(n);
  if (!s) {
    const p = smallestFactor(n);
    const m = n / p;
    const cos = new Float64Array(p * n);
    const sin = new Float64Array(p * n);
    for (let j = 0; j < p; j++)
      for (let k = 0; k < n; k++) {
        const ang = (-2 * Math.PI * j * k) / n;
        cos[j * n + k] = Math.cos(ang);
        sin[j * n + k] = Math.sin(ang);
      }
    const subRe = Array.from({ length: p }, () => new Float64Array(m));
    const subIm = Array.from({ length: p }, () => new Float64Array(m));
    s = { p, m, cos, sin, subRe, subIm };
    stages.set(n, s);
  }
  return s;
}

function fft(re: Float64Array, im: Float64Array, n: number, stride: number, offset: number, outRe: Float64Array, outIm: Float64Array): void {
  if (n === 1) {
    outRe[0] = re[offset];
    outIm[0] = im[offset];
    return;
  }
  const { p, m, cos, sin, subRe, subIm } = stage(n);
  for (let j = 0; j < p; j++) fft(re, im, m, stride * p, offset + j * stride, subRe[j], subIm[j]);
  for (let k = 0; k < n; k++) {
    const km = k % m;
    let accRe = 0;
    let accIm = 0;
    for (let j = 0; j < p; j++) {
      const c = cos[j * n + k];
      const s = sin[j * n + k];
      const yr = subRe[j][km];
      const yi = subIm[j][km];
      accRe += yr * c - yi * s;
      accIm += yr * s + yi * c;
    }
    outRe[k] = accRe;
    outIm[k] = accIm;
  }
}

/**
 * Pads (at the start) or truncates (keeping the end) to the last 8 s, the way Smart Turn wants it.
 */
export function lastEightSeconds(audio: Float32Array): Float32Array {
  if (audio.length === SMART_TURN_SAMPLES) return audio;
  if (audio.length > SMART_TURN_SAMPLES) return audio.subarray(audio.length - SMART_TURN_SAMPLES);
  const out = new Float32Array(SMART_TURN_SAMPLES);
  out.set(audio, SMART_TURN_SAMPLES - audio.length);
  return out;
}

export function whisperLogMel(audio: Float32Array): Float32Array {
  const n = SMART_TURN_SAMPLES;
  const x = new Float64Array(n);
  x.set(audio.subarray(0, Math.min(n, audio.length)));

  // zero-mean, unit-variance waveform normalization before the spectrogram
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (x[i] - mean) ** 2;
  variance /= n;
  const scale = 1 / Math.sqrt(variance + 1e-7);
  for (let i = 0; i < n; i++) x[i] = (x[i] - mean) * scale;

  // centered frames: reflect-pad N_FFT/2 on both sides
  const pad = N_FFT / 2;
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    padded[i] = x[pad - i];
    padded[n + pad + i] = x[n - 2 - i];
  }
  padded.set(x, pad);

  const frames = Math.floor((padded.length - N_FFT) / HOP) + 1; // 801; the last one is dropped
  const logSpec = new Float64Array(N_MELS * N_FRAMES);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const outRe = new Float64Array(N_FFT);
  const outIm = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  let maxLog = -Infinity;
  for (let f = 0; f < Math.min(frames, N_FRAMES); f++) {
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[start + i] * HANN[i];
      im[i] = 0;
    }
    fft(re, im, N_FFT, 1, 0, outRe, outIm);
    for (let b = 0; b < N_BINS; b++) power[b] = outRe[b] * outRe[b] + outIm[b] * outIm[b];
    for (let m = 0; m < N_MELS; m++) {
      const filt = MEL_FILTERS[m];
      let acc = 0;
      for (let b = 0; b < N_BINS; b++) acc += filt[b] * power[b];
      const v = Math.log10(Math.max(1e-10, acc));
      logSpec[m * N_FRAMES + f] = v;
      if (v > maxLog) maxLog = v;
    }
  }
  const out = new Float32Array(N_MELS * N_FRAMES);
  const floor = maxLog - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(logSpec[i], floor) + 4) / 4;
  return out;
}
