/**
 * Mikrofon-Aufnahme und Analyse-Schleife.
 */

import { resumeAudio } from './audio';
import { PitchDetector, median, RMS_GATE } from './pitch';
import { centsBetween, nearestString, stringById, type GuitarString } from './notes';

/**
 * 8192 Samples ≈ 186 ms bei 44.1 kHz. Das Minimum laut Anforderung wären 4096;
 * mehr Fenster hilft der tiefen E-Saite spürbar, weil die Autokorrelation dort
 * mehrere volle Perioden braucht (82 Hz = 535 Samples pro Periode).
 */
const BUFFER_SIZE = 8192;

/** Analyseintervall. Häufiger als das bringt nichts, das Fenster ist länger. */
const ANALYSIS_INTERVAL_MS = 40;

/** Fenstergröße der Median-Glättung. */
const SMOOTHING_WINDOW = 5;

/**
 * So viele stille Frames werden toleriert, bevor auf "kein Signal" umgeschaltet
 * wird. Eine gezupfte Saite klingt aus, ohne Nachlauf würde die Anzeige flackern.
 */
const SILENCE_HOLD_FRAMES = 8;

export type TunerState =
  | { kind: 'idle' }
  | { kind: 'listening'; rms: number }
  | {
      kind: 'pitch';
      frequency: number;
      target: GuitarString;
      cents: number;
      clarity: number;
      locked: boolean;
    };

export class MicTunerError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'MicTunerError';
  }
}

export class Tuner {
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private nodes: AudioNode[] = [];
  private detector: PitchDetector | null = null;
  private buffer = new Float32Array(BUFFER_SIZE);
  private timerId: number | null = null;
  private history: number[] = [];
  private silentFrames = 0;

  /** Wenn gesetzt, wird immer gegen diese Saite gemessen statt automatisch zu wählen. */
  lockedStringId: string | null = null;

  constructor(private readonly onState: (state: TunerState) => void) {}

  get running(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!window.isSecureContext) {
      throw new MicTunerError(
        'Mikrofonzugriff ist in diesem Kontext nicht erlaubt.',
        'Browser geben das Mikrofon nur über HTTPS oder auf localhost frei. Öffne die Seite über http://localhost:5173 oder per HTTPS.',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicTunerError(
        'Dieser Browser stellt keine Mikrofon-API bereit.',
        'Die Referenztöne unten funktionieren trotzdem.',
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Alle drei Aufbereitungen abschalten: Sie sind für Sprache gebaut.
          // AGC verbiegt die Pegel (macht das Noise Gate unbrauchbar),
          // Noise Suppression frisst stehende Töne, Echo Cancellation kann
          // ganze Frequenzbereiche wegfiltern.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      throw toMicError(err);
    }

    const ctx = await resumeAudio();

    const analyser = ctx.createAnalyser();
    // getFloatTimeDomainData() liefert genau fftSize Samples – wir benutzen den
    // Analyser also nur als Ringpuffer, nicht für sein Spektrum.
    analyser.fftSize = BUFFER_SIZE;

    // Vorfilterung: Trittschall/Netzbrumm unterhalb der tiefen E-Saite raus,
    // alles oberhalb der Grundtöne dämpfen. Das entlastet die Autokorrelation,
    // weil starke Obertöne sonst konkurrierende Peaks erzeugen.
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 60;
    highpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1200;
    lowpass.Q.value = 0.7;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(highpass).connect(lowpass).connect(analyser);
    // Bewusst NICHT an ctx.destination – sonst Rückkopplung über den Lautsprecher.

    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.nodes = [highpass, lowpass];
    this.detector = new PitchDetector(BUFFER_SIZE);
    this.history = [];
    this.silentFrames = 0;

    // Wenn der Nutzer die Freigabe im Browser-UI zurückzieht.
    stream.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => this.stop());
    });

    // setInterval statt requestAnimationFrame: Die Analyse hängt nicht am
    // Bildaufbau, und rAF pausiert vollständig, sobald der Tab nicht sichtbar
    // ist – dann würde die Anzeige auf dem letzten Wert einfrieren.
    this.timerId = window.setInterval(this.analyse, ANALYSIS_INTERVAL_MS);
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.nodes.forEach((n) => n.disconnect());
    this.analyser?.disconnect();

    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.nodes = [];
    this.detector = null;
    this.history = [];
    this.onState({ kind: 'idle' });
  }

  private analyse = (): void => {
    const analyser = this.analyser;
    const detector = this.detector;
    if (!analyser || !detector) return;

    analyser.getFloatTimeDomainData(this.buffer);
    const result = detector.detect(this.buffer, analyser.context.sampleRate);

    if (result.frequency === null) {
      this.silentFrames++;
      if (this.silentFrames >= SILENCE_HOLD_FRAMES) {
        this.history = [];
        this.onState({ kind: 'listening', rms: result.rms });
      }
      return;
    }

    this.silentFrames = 0;
    this.history.push(result.frequency);
    if (this.history.length > SMOOTHING_WINDOW) this.history.shift();

    // Erst ab der Hälfte des Fensters anzeigen, damit der erste Wert nach einer
    // Pause nicht ungeglättet durchschlägt.
    if (this.history.length < Math.ceil(SMOOTHING_WINDOW / 2)) return;

    const smoothed = median(this.history);
    const locked = this.lockedStringId !== null;
    const target = (locked ? stringById(this.lockedStringId!) : undefined) ?? nearestString(smoothed);

    this.onState({
      kind: 'pitch',
      frequency: smoothed,
      target,
      cents: centsBetween(smoothed, target.freq),
      clarity: result.clarity,
      locked,
    });
  };
}

export { RMS_GATE };

function toMicError(err: unknown): MicTunerError {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicTunerError(
        'Mikrofonzugriff wurde abgelehnt.',
        'Erlaube den Zugriff im Schloss-Symbol der Adressleiste und starte erneut. Die Referenztöne funktionieren auch ohne Mikrofon.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicTunerError(
        'Kein passendes Mikrofon gefunden.',
        'Schließe ein Mikrofon an oder benutze die Referenztöne unten.',
      );
    case 'NotReadableError':
      return new MicTunerError(
        'Das Mikrofon ist belegt.',
        'Eine andere Anwendung benutzt es gerade. Schließe sie und versuche es noch einmal.',
      );
    default:
      return new MicTunerError(
        'Mikrofon konnte nicht gestartet werden.',
        err instanceof Error ? err.message : undefined,
      );
  }
}
