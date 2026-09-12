/**
 * Gemeinsamer AudioContext für Mikrofon-Analyse und Referenzton.
 *
 * Er wird bewusst erst beim ersten Klick erzeugt: Browser starten einen
 * AudioContext ohne User-Geste im Zustand "suspended", und ein zweiter
 * Context würde unnötig eine weitere Audio-Hardware-Session aufmachen.
 */

type AudioContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor: AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API wird von diesem Browser nicht unterstützt.');
    ctx = new Ctor();
  }
  return ctx;
}

/** Nach jeder User-Geste aufrufen – iOS/Safari suspendiert gern von selbst. */
export async function resumeAudio(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === 'suspended') await c.resume();
  return c;
}
