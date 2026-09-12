/**
 * UI-Verdrahtung: Mikrofon-Stimmanzeige + Referenztöne.
 */

import './style.css';
import { STRINGS } from './notes';
import { ReferenceTonePlayer } from './reference';
import { Tuner, MicTunerError, RMS_GATE, type TunerState } from './tuner';

/** Grenzen der Farbzonen in Cent. */
const IN_TUNE_CENTS = 5;
const CLOSE_CENTS = 15;
/** Sichtbarer Bereich der Skala. */
const GAUGE_RANGE = 50;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} fehlt im DOM`);
  return node as T;
}

const ui = {
  display: el('display'),
  note: el('note'),
  stringLabel: el('stringLabel'),
  lockBadge: el('lockBadge'),
  gaugeTrack: el('gaugeTrack'),
  needle: el('needle'),
  cents: el('centsValue'),
  freq: el('freqValue'),
  target: el('targetValue'),
  direction: el('direction'),
  levelWrap: el('levelWrap'),
  levelBar: el('levelBar'),
  micBtn: el<HTMLButtonElement>('micBtn'),
  autoBtn: el<HTMLButtonElement>('autoBtn'),
  message: el('message'),
  stringGrid: el('stringGrid'),
};

const player = new ReferenceTonePlayer();
const tuner = new Tuner(render);

/** Breite der Skala in px – wird für die Zeigerposition gebraucht. */
let trackWidth = 0;
const measureTrack = () => {
  trackWidth = ui.gaugeTrack.clientWidth;
};

// ── Saiten-Karten aufbauen ──────────────────────────────────────────────

const lockButtons = new Map<string, HTMLButtonElement>();
const playButtons = new Map<string, HTMLButtonElement>();
const cards = new Map<string, HTMLElement>();

for (const s of STRINGS) {
  const card = document.createElement('div');
  card.className = 'string-card';
  card.dataset.locked = 'false';

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'sc-select';
  select.setAttribute('aria-pressed', 'false');
  select.innerHTML =
    `<span class="sc-note">${s.id}</span>` +
    `<span class="sc-freq">${s.freq.toFixed(2)} Hz</span>` +
    `<span class="sc-num">${s.number}. Saite</span>`;
  select.addEventListener('click', () => toggleLock(s.id));

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play-btn';
  play.dataset.playing = 'false';
  play.textContent = '♪ Ton';
  play.setAttribute('aria-label', `Referenzton ${s.id} abspielen`);
  play.addEventListener('click', () => {
    void player.toggle(s.id, s.freq);
  });

  card.append(select, play);
  ui.stringGrid.append(card);

  cards.set(s.id, card);
  lockButtons.set(s.id, select);
  playButtons.set(s.id, play);
}

player.setOnChange((id) => {
  for (const [key, btn] of playButtons) {
    btn.dataset.playing = String(key === id);
    btn.textContent = key === id ? '■ Stopp' : '♪ Ton';
  }
});

// ── Saite fixieren / freigeben ──────────────────────────────────────────

function toggleLock(id: string): void {
  tuner.lockedStringId = tuner.lockedStringId === id ? null : id;
  syncLockUi();
}

function syncLockUi(): void {
  const locked = tuner.lockedStringId;
  for (const [key, card] of cards) {
    const on = key === locked;
    card.dataset.locked = String(on);
    lockButtons.get(key)!.setAttribute('aria-pressed', String(on));
  }
  ui.autoBtn.hidden = locked === null;
  ui.lockBadge.hidden = locked === null;
}

ui.autoBtn.addEventListener('click', () => {
  tuner.lockedStringId = null;
  syncLockUi();
});

// ── Mikrofon ────────────────────────────────────────────────────────────

ui.micBtn.addEventListener('click', () => {
  if (tuner.running) {
    tuner.stop();
    setMicButton(false);
    showMessage(null);
    return;
  }

  ui.micBtn.disabled = true;
  ui.micBtn.textContent = 'Starte …';
  tuner
    .start()
    .then(() => {
      setMicButton(true);
      showMessage(null);
    })
    .catch((err: unknown) => {
      setMicButton(false);
      if (err instanceof MicTunerError) {
        showMessage(err.message, err.hint, 'error');
      } else {
        showMessage('Unerwarteter Fehler beim Mikrofonstart.', String(err), 'error');
      }
    })
    .finally(() => {
      ui.micBtn.disabled = false;
      measureTrack();
    });
});

function setMicButton(active: boolean): void {
  ui.micBtn.dataset.active = String(active);
  ui.micBtn.textContent = active ? 'Mikrofon stoppen' : 'Mikrofon starten';
}

function showMessage(text: string | null, hint?: string, kind: 'error' | 'info' = 'error'): void {
  if (!text) {
    ui.message.hidden = true;
    ui.message.textContent = '';
    return;
  }
  ui.message.hidden = false;
  ui.message.dataset.kind = kind;
  ui.message.textContent = text;
  if (hint) {
    const span = document.createElement('span');
    span.className = 'hint';
    span.textContent = hint;
    ui.message.append(span);
  }
}

// ── Anzeige ─────────────────────────────────────────────────────────────

function render(state: TunerState): void {
  switch (state.kind) {
    case 'idle':
      ui.display.dataset.state = 'idle';
      ui.note.textContent = '–';
      ui.stringLabel.textContent = 'Mikrofon gestoppt';
      ui.cents.textContent = '–';
      ui.freq.textContent = '–';
      ui.target.textContent = '–';
      ui.direction.textContent = 'Bereit.';
      ui.needle.style.transform = 'translateX(0px)';
      ui.levelWrap.hidden = true;
      break;

    case 'listening': {
      ui.display.dataset.state = 'idle';
      ui.note.textContent = '–';
      ui.stringLabel.textContent = 'kein Signal';
      ui.cents.textContent = '–';
      ui.freq.textContent = '–';
      ui.target.textContent = '–';
      ui.direction.textContent = 'Saite anschlagen …';
      ui.needle.style.transform = 'translateX(0px)';
      ui.levelWrap.hidden = false;
      // Pegel relativ zur Noise-Gate-Schwelle: 100 % = doppelte Schwelle.
      const pct = Math.min(100, (state.rms / (RMS_GATE * 2)) * 100);
      ui.levelBar.style.width = `${pct.toFixed(0)}%`;
      break;
    }

    case 'pitch': {
      const { cents, frequency, target, locked } = state;
      const abs = Math.abs(cents);

      ui.display.dataset.state =
        abs < IN_TUNE_CENTS ? 'in-tune' : abs < CLOSE_CENTS ? 'close' : 'off';

      ui.note.textContent = target.id;
      ui.stringLabel.textContent = `${target.number}. Saite${locked ? '' : ' · automatisch erkannt'}`;
      ui.cents.textContent = `${cents >= 0 ? '+' : '−'}${abs.toFixed(1)}`;
      ui.freq.textContent = frequency.toFixed(2);
      ui.target.textContent = target.freq.toFixed(2);
      ui.levelWrap.hidden = true;

      // Zeiger: ±GAUGE_RANGE Cent entsprechen der halben Skalenbreite.
      const clamped = Math.max(-GAUGE_RANGE, Math.min(GAUGE_RANGE, cents));
      if (!trackWidth) measureTrack();
      ui.needle.style.transform = `translateX(${((clamped / (GAUGE_RANGE * 2)) * trackWidth).toFixed(1)}px)`;

      if (abs < IN_TUNE_CENTS) {
        ui.direction.textContent = '✓ gestimmt';
      } else if (cents < 0) {
        ui.direction.textContent = `${abs.toFixed(0)} Cent zu tief — höher stimmen ↑`;
      } else {
        ui.direction.textContent = `${abs.toFixed(0)} Cent zu hoch — tiefer stimmen ↓`;
      }
      if (abs > GAUGE_RANGE) {
        ui.direction.textContent += ' (weit daneben)';
      }
      break;
    }
  }
}

// ── Start ───────────────────────────────────────────────────────────────

window.addEventListener('resize', measureTrack);
measureTrack();
syncLockUi();
setMicButton(false);
// Kein render() beim Start – das HTML enthält bereits den Ausgangszustand.

// Hinweis schon vor dem ersten Klick, wenn das Mikrofon ohnehin blockiert wäre.
if (!window.isSecureContext) {
  showMessage(
    'Diese Seite läuft nicht in einem sicheren Kontext.',
    'Mikrofonzugriff braucht HTTPS oder localhost. Die Referenztöne unten funktionieren trotzdem.',
    'info',
  );
} else if (!navigator.mediaDevices?.getUserMedia) {
  showMessage(
    'Dieser Browser bietet keinen Mikrofonzugriff.',
    'Die Referenztöne unten funktionieren trotzdem.',
    'info',
  );
}
