/**
 * Tonhöhenerkennung per Autokorrelation – konkret die McLeod Pitch Method (MPM)
 * über die "Normalised Square Difference Function" (NSDF).
 *
 * Warum keine reine FFT:
 * Bei 4096 Samples und 48 kHz beträgt die Bin-Breite 48000/4096 ≈ 11.7 Hz.
 * Die tiefe E-Saite liegt bei 82.41 Hz, ein einziger Cent sind dort 0.048 Hz –
 * das Spektrum ist also rund 240x zu grob. Die Autokorrelation misst dagegen
 * die Periodenlänge in Samples und erreicht mit Parabel-Interpolation
 * Bruchteile eines Samples, was bei 82 Hz weit unter einem Cent liegt.
 *
 * Ablauf:
 *  1. Gleichanteil (DC-Offset) entfernen und RMS bestimmen (Noise Gate).
 *  2. Autokorrelation r(τ) über FFT (Wiener-Chintschin: r = IFFT(|FFT(x)|²)).
 *  3. Normierung zur NSDF:  n(τ) = 2·r(τ) / m(τ)
 *     mit m(τ) = Σ (x[j]² + x[j+τ]²).  n(τ) liegt damit in [-1, 1] und ist
 *     unabhängig von der Lautstärke – anders als rohes r(τ), das bei großen τ
 *     systematisch abfällt und deshalb Oktavfehler nach oben provoziert.
 *  4. Erstes "key maximum" der NSDF suchen, das mindestens K·(höchstes Maximum)
 *     erreicht. Das erste statt das höchste zu nehmen ist der Trick gegen
 *     Oktavfehler nach unten (τ = 2·Periode korreliert fast genauso gut).
 *  5. Peak per Parabel interpolieren -> Periode in Samples -> f = fs / τ.
 */

import { FFT } from './fft';

export interface PitchResult {
  /** Erkannte Grundfrequenz in Hz, oder null wenn nichts Brauchbares da war. */
  frequency: number | null;
  /** NSDF-Wert am gewählten Peak, 0..1. Je höher, desto periodischer das Signal. */
  clarity: number;
  /** Effektivwert des Blocks, für Noise-Gate-Anzeige. */
  rms: number;
  /** Warum es kein Ergebnis gab. */
  reason: 'ok' | 'too-quiet' | 'not-periodic';
}

/** Suchbereich. Tiefste Gitarrensaite 82.4 Hz, höchste leere Saite 329.6 Hz. */
const MIN_FREQ = 60;
const MAX_FREQ = 600;

/** RMS-Schwelle des Noise Gates (≈ -46 dBFS). Darunter: "kein Signal". */
export const RMS_GATE = 0.005;

/** Mindest-Periodizität. Darunter gilt das Signal als Rauschen/Geräusch. */
const MIN_CLARITY = 0.6;

/**
 * Schwelle für die Peak-Auswahl: das erste Maximum, das K · höchstes Maximum
 * erreicht, gewinnt. Kleiner = eher tiefere Oktave, größer = eher höhere.
 */
const PEAK_THRESHOLD = 0.9;

export class PitchDetector {
  private readonly n: number;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly nsdf: Float64Array;
  private readonly work: Float64Array;

  /** @param bufferSize Anzahl Samples pro Analyseblock (Zweierpotenz, >= 4096). */
  constructor(bufferSize: number) {
    this.n = bufferSize;
    // Für eine zyklusfreie (lineare) Autokorrelation muss auf 2N gezeropadded
    // werden, sonst faltet die FFT das Signalende auf den Anfang zurück.
    this.fft = new FFT(bufferSize * 2);
    this.re = new Float64Array(bufferSize * 2);
    this.im = new Float64Array(bufferSize * 2);
    this.nsdf = new Float64Array(bufferSize);
    this.work = new Float64Array(bufferSize);
  }

  detect(input: Float32Array, sampleRate: number): PitchResult {
    const n = this.n;
    const x = this.work;

    // --- 1. DC-Offset entfernen ---------------------------------------------
    // Ein konstanter Gleichanteil (manche Mikrofone/ADCs haben einen) erzeugt
    // in der Autokorrelation einen Sockel, der echte Peaks überdeckt.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += input[i];
    mean /= n;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = input[i] - mean;
      x[i] = v;
      sumSq += v * v;
    }

    // --- 2. Noise Gate ------------------------------------------------------
    const rms = Math.sqrt(sumSq / n);
    if (rms < RMS_GATE) {
      return { frequency: null, clarity: 0, rms, reason: 'too-quiet' };
    }

    // --- 3. Autokorrelation über die FFT ------------------------------------
    // r(τ) = IFFT( FFT(x) · conj(FFT(x)) ) = IFFT( |FFT(x)|² )
    const re = this.re;
    const im = this.im;
    re.set(x.subarray(0, n));
    re.fill(0, n);
    im.fill(0);

    this.fft.transform(re, im, false);
    for (let i = 0; i < re.length; i++) {
      // Leistungsspektrum; der Imaginärteil verschwindet, weil x reell ist.
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    // re[τ] ist jetzt die Autokorrelation r(τ) für τ = 0 .. n-1.

    // --- 4. Normierung zur NSDF ---------------------------------------------
    // m(τ) = Σ_{j<n-τ} x[j]² + Σ_{j>=τ} x[j]²
    // lässt sich inkrementell fortschreiben:
    //   m(0)   = 2 · Σ x[j]²
    //   m(τ)   = m(τ-1) - x[n-τ]² - x[τ-1]²
    const nsdf = this.nsdf;
    let m = 2 * sumSq;
    nsdf[0] = 1;
    for (let tau = 1; tau < n; tau++) {
      m -= x[n - tau] * x[n - tau] + x[tau - 1] * x[tau - 1];
      nsdf[tau] = m > 1e-12 ? (2 * re[tau]) / m : 0;
    }

    // --- 5. Peak-Suche ------------------------------------------------------
    const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxLag = Math.min(n - 2, Math.ceil(sampleRate / MIN_FREQ));
    if (maxLag <= minLag) {
      return { frequency: null, clarity: 0, rms, reason: 'not-periodic' };
    }

    // Die NSDF startet bei n(0) = 1. Dieser Haupt-Lobe gehört zu τ=0 und ist
    // kein Periodenkandidat – also bis zum ersten Nulldurchgang überspringen.
    let tau = 1;
    while (tau < maxLag && nsdf[tau] > 0) tau++;

    // Alle "key maxima" sammeln: je positiver Lobe genau ein Maximum.
    let bestVal = -Infinity;
    const peakTaus: number[] = [];
    const peakVals: number[] = [];

    while (tau < maxLag) {
      while (tau < maxLag && nsdf[tau] <= 0) tau++;
      if (tau >= maxLag) break;

      let lobeTau = tau;
      let lobeVal = nsdf[tau];
      while (tau < maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > lobeVal) {
          lobeVal = nsdf[tau];
          lobeTau = tau;
        }
        tau++;
      }

      if (lobeTau >= minLag) {
        peakTaus.push(lobeTau);
        peakVals.push(lobeVal);
        if (lobeVal > bestVal) bestVal = lobeVal;
      }
    }

    if (peakTaus.length === 0 || bestVal < MIN_CLARITY) {
      return { frequency: null, clarity: Math.max(0, bestVal), rms, reason: 'not-periodic' };
    }

    // Erstes Maximum nehmen, das nah genug am globalen Maximum liegt.
    const threshold = PEAK_THRESHOLD * bestVal;
    let chosen = peakTaus[peakTaus.length - 1];
    let clarity = peakVals[peakVals.length - 1];
    for (let i = 0; i < peakTaus.length; i++) {
      if (peakVals[i] >= threshold) {
        chosen = peakTaus[i];
        clarity = peakVals[i];
        break;
      }
    }

    // --- 6. Sub-Sample-Genauigkeit per Parabel ------------------------------
    // Durch die drei Punkte (τ-1, τ, τ+1) wird eine Parabel gelegt; deren
    // Scheitel ist die eigentliche Periodenlänge. Ohne diesen Schritt wäre die
    // Auflösung bei 82 Hz auf ganze Samples begrenzt, also ca. 3 Cent.
    const y1 = nsdf[chosen - 1];
    const y2 = nsdf[chosen];
    const y3 = nsdf[chosen + 1];
    const denom = y1 - 2 * y2 + y3;
    const shift = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
    const period = chosen + (Math.abs(shift) < 1 ? shift : 0);

    const frequency = sampleRate / period;
    if (!isFinite(frequency) || frequency < MIN_FREQ || frequency > MAX_FREQ) {
      return { frequency: null, clarity, rms, reason: 'not-periodic' };
    }

    return { frequency, clarity: Math.min(1, clarity), rms, reason: 'ok' };
  }
}

/**
 * Median der letzten Messungen.
 *
 * Median statt Mittelwert, weil einzelne Ausreißer (Oktavsprung, Anschlag-
 * geräusch) den Mittelwert kräftig verziehen, den Median aber gar nicht –
 * solange sie in der Minderheit sind. Genau das macht die Anzeige ruhig.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
