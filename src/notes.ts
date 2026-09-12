/**
 * Notenmathematik.
 *
 * Alle Frequenzen werden aus dem Halbtonabstand zur Referenz A4 berechnet,
 * nichts ist als Zahl hardcodiert. Grundlage ist die gleichstufige Stimmung:
 * eine Oktave = 12 Halbtöne, ein Halbton = Frequenzverhältnis 2^(1/12).
 */

/** Kammerton. A4 hat die MIDI-Nummer 69. */
export const A4_HZ = 440;
const A4_MIDI = 69;

/**
 * Frequenz einer MIDI-Note.
 *
 *   f(n) = a4 * 2^((n - 69) / 12)
 *
 * Beispiel E2 (MIDI 40): 440 * 2^(-29/12) = 82.4069 Hz
 */
export function midiToFreq(midi: number, a4 = A4_HZ): number {
  return a4 * Math.pow(2, (midi - A4_MIDI) / 12);
}

/**
 * Abweichung in Cent zwischen Ist- und Soll-Frequenz.
 *
 *   cents = 1200 * log2(f_ist / f_soll)
 *
 * 100 Cent = 1 Halbton. Negativ = zu tief, positiv = zu hoch.
 */
export function centsBetween(actual: number, target: number): number {
  return 1200 * Math.log2(actual / target);
}

export interface GuitarString {
  /** Stabile ID, gleichzeitig Anzeigename, z. B. "E2". */
  id: string;
  /** Notenname ohne Oktave, z. B. "E". */
  note: string;
  /** Oktavlage nach wissenschaftlicher Notation. */
  octave: number;
  /** Saitennummer wie auf der Gitarre: 6 = tiefe E-Saite, 1 = hohe E-Saite. */
  number: number;
  /** MIDI-Notennummer, daraus wird die Frequenz berechnet. */
  midi: number;
  /** Soll-Frequenz in Hz (abgeleitet, nicht hardcodiert). */
  freq: number;
}

/**
 * E-Standard von der tiefen zur hohen Saite.
 * Nur die MIDI-Nummern sind angegeben – die Frequenzen fallen aus midiToFreq().
 *
 *   E2=40 -> 82.41 | A2=45 -> 110.00 | D3=50 -> 146.83
 *   G3=55 -> 196.00 | B3=59 -> 246.94 | E4=64 -> 329.63
 */
export const STRINGS: GuitarString[] = [
  { note: 'E', octave: 2, number: 6, midi: 40 },
  { note: 'A', octave: 2, number: 5, midi: 45 },
  { note: 'D', octave: 3, number: 4, midi: 50 },
  { note: 'G', octave: 3, number: 3, midi: 55 },
  { note: 'B', octave: 3, number: 2, midi: 59 },
  { note: 'E', octave: 4, number: 1, midi: 64 },
].map((s) => ({
  ...s,
  id: `${s.note}${s.octave}`,
  freq: midiToFreq(s.midi),
}));

export function stringById(id: string): GuitarString | undefined {
  return STRINGS.find((s) => s.id === id);
}

/**
 * Ordnet eine gemessene Frequenz der Saite mit dem kleinsten Cent-Abstand zu.
 *
 * Der Vergleich läuft bewusst über Cent und nicht über die Hz-Differenz:
 * Hz-Abstände sind im Bass eng und in der Höhe weit, Cent-Abstände sind
 * über alle Oktaven gleich gewichtet.
 */
export function nearestString(freq: number): GuitarString {
  let best = STRINGS[0];
  let bestDist = Infinity;
  for (const s of STRINGS) {
    const dist = Math.abs(centsBetween(freq, s.freq));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}
