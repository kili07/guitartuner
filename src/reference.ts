/**
 * Referenztöne über OscillatorNode.
 *
 * Ein reiner Sinus ist gegen eine Gitarre schwer zu hören – er hat keine
 * Obertöne, mit denen das Ohr Schwebungen vergleichen könnte. Deshalb wird
 * eine PeriodicWave aus Grundton + einigen Obertönen gebaut.
 */

import { getAudioContext, resumeAudio } from './audio';

/** Amplituden der Teiltöne: Index 1 = Grundton, 2 = Oktave, 3 = Quinte, ... */
const HARMONICS = [0, 1, 0.5, 0.28, 0.16, 0.09, 0.05, 0.03];

const ATTACK = 0.03;
const RELEASE = 0.12;
const PEAK_GAIN = 0.22;
/** Harte Obergrenze, damit kein Ton vergessen weiterläuft. */
const MAX_DURATION = 5;

let wave: PeriodicWave | null = null;

function getWave(ctx: AudioContext): PeriodicWave {
  if (!wave) {
    // real = Kosinus-Anteile, imag = Sinus-Anteile. Index 0 ist der Gleichanteil
    // und bleibt 0. Normalisierung übernimmt der Browser.
    const real = new Float32Array(HARMONICS.length);
    const imag = Float32Array.from(HARMONICS);
    wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  return wave;
}

export class ReferenceTonePlayer {
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private timer: number | null = null;
  private playingId: string | null = null;
  private onChange: ((id: string | null) => void) | null = null;

  /** Callback bei jedem Start/Stopp, damit die UI den aktiven Button markiert. */
  setOnChange(cb: (id: string | null) => void): void {
    this.onChange = cb;
  }

  get current(): string | null {
    return this.playingId;
  }

  /** Toggle: gleiche Saite erneut -> Stopp, andere Saite -> Wechsel. */
  async toggle(id: string, freq: number): Promise<void> {
    if (this.playingId === id) {
      this.stop();
      return;
    }
    await this.play(id, freq);
  }

  async play(id: string, freq: number): Promise<void> {
    const ctx = await resumeAudio();
    this.stop();

    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(getWave(ctx));
    osc.frequency.value = freq;

    // Die oberen Teiltöne etwas zurücknehmen, sonst klingt es scharf.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(ctx.sampleRate / 2 - 1000, freq * 8);
    tone.Q.value = 0.7;

    // Hüllkurve: ohne Rampe springt die Amplitude von 0 auf Vollgas und
    // erzeugt einen hörbaren Knack (eine Sprungfunktion ist breitbandig).
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, now + ATTACK);

    osc.connect(tone).connect(gain).connect(ctx.destination);
    osc.start(now);

    this.osc = osc;
    this.gain = gain;
    this.playingId = id;
    this.onChange?.(id);

    this.timer = window.setTimeout(() => this.stop(), MAX_DURATION * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const osc = this.osc;
    const gain = this.gain;
    this.osc = null;
    this.gain = null;

    if (osc && gain) {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      // Laufende Rampen abbrechen und sanft ausblenden, dann erst stoppen.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE);
      osc.stop(now + RELEASE + 0.02);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }

    if (this.playingId !== null) {
      this.playingId = null;
      this.onChange?.(null);
    }
  }
}
