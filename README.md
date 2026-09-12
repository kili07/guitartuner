# Gitarren-Stimmgerät (E-Standard)

Web-App zum Stimmen einer 6-saitigen Gitarre in E-Standard. Erkennt die
gespielte Saite über das Mikrofon und zeigt die Abweichung in Cent an.
Zusätzlich lassen sich Referenztöne abspielen.

Vite + Vanilla TypeScript, Web Audio API, reines CSS — keine Laufzeit-Abhängigkeiten.

## Start

```bash
npm install
npm run dev
```

Dann <http://localhost:5173> öffnen.

| Befehl            | Wirkung                                              |
| ----------------- | ---------------------------------------------------- |
| `npm run dev`     | Entwicklungsserver auf localhost                     |
| `npm run dev:lan` | Zusätzlich im lokalen Netz erreichbar (siehe Hinweis) |
| `npm run build`   | Typprüfung + Produktions-Build nach `dist/`          |
| `npm run preview` | Gebauten Stand lokal ausliefern                      |

### Mikrofon braucht HTTPS oder localhost

Browser geben `getUserMedia` nur in einem *secure context* frei: über HTTPS
oder auf `http://localhost`. Die App erkennt das und zeigt einen Hinweis;
die Referenztöne funktionieren auch dann.

Zum Testen am Handy reicht `npm run dev:lan` deshalb **nicht** — `http://192.168.x.x`
ist kein sicherer Kontext. Möglichkeiten:

- einen Tunnel benutzen, z. B. `npx localtunnel --port 5173` oder `cloudflared tunnel --url http://localhost:5173`
- oder in Chrome unter `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
  die LAN-Adresse eintragen

## Auf GitHub Pages veröffentlichen

GitHub Pages liefert über **HTTPS** aus — das Mikrofon funktioniert dort also
ohne Tunnel oder Browser-Flag, auch auf dem Handy. Das ist der bequemste Weg
zum Testen unterwegs.

```bash
git init
git add .
git commit -m "Stimmgerät"
git branch -M main
git remote add origin https://github.com/<dein-name>/<repo>.git
git push -u origin main
```

Danach im Repo unter **Settings → Pages** bei *Source* **GitHub Actions**
auswählen. Der Workflow in `.github/workflows/deploy.yml` baut und veröffentlicht
bei jedem Push auf `main`. Die Seite liegt dann unter
`https://<dein-name>.github.io/<repo>/`.

Hinweise:

- Das Repo muss **öffentlich** sein, sonst braucht Pages ein kostenpflichtiges Konto.
- `vite.config.ts` setzt `base: './'`, damit die Asset-Pfade relativ sind. Mit dem
  Vite-Standard `'/'` würden sie auf die Domain-Wurzel statt ins Repo-Unterverzeichnis
  zeigen und die Seite bliebe weiß. Dadurch ist der Repo-Name egal.
- Beim ersten Aufruf fragt der Browser nach der Mikrofon-Freigabe. Safari auf iOS
  fragt bei jedem Besuch neu — das ist normal und keine Fehlfunktion.

## Bedienung

1. **Mikrofon starten** antippen und den Zugriff erlauben.
2. Eine Saite anschlagen. Die App erkennt automatisch, welche Saite gemeint ist,
   und zeigt Saitenname, gemessene Frequenz und die Abweichung in Cent.
3. Der Zeiger läuft auf einer Skala von −50 bis +50 Cent:
   **grün** unter 5 Cent, **gelb** unter 15 Cent, sonst **rot**.
4. Auf eine Saiten-Karte tippen, um die Saite zu **fixieren** — dann wird nur noch
   gegen diese Saite gemessen. Das hilft, wenn eine Saite so verstimmt ist, dass
   die Automatik zur Nachbarsaite springt. „Auto-Erkennung" hebt die Fixierung auf.
5. **♪ Ton** spielt den Referenzton der Saite (max. 5 Sekunden, erneutes Tippen stoppt).

> Für den Referenzton möglichst Kopfhörer benutzen — sonst hört das Mikrofon
> den eigenen Ton mit und zeigt ihn als „perfekt gestimmt" an.

## Zielfrequenzen

Alle Frequenzen werden aus dem Halbtonabstand zum Kammerton A4 = 440 Hz
berechnet (`src/notes.ts`), nichts ist als Zahl hinterlegt:

```
f(n) = 440 · 2^((n − 69) / 12)        n = MIDI-Notennummer
```

| Saite | Note | MIDI | Frequenz    |
| ----- | ---- | ---- | ----------- |
| 6     | E2   | 40   | 82.4069 Hz  |
| 5     | A2   | 45   | 110.0000 Hz |
| 4     | D3   | 50   | 146.8324 Hz |
| 3     | G3   | 55   | 195.9977 Hz |
| 2     | B3   | 59   | 246.9417 Hz |
| 1     | E4   | 64   | 329.6276 Hz |

## Wie die Tonhöhe erkannt wird

Per **Autokorrelation**, konkret der McLeod Pitch Method (MPM) über die
Normalised Square Difference Function — siehe `src/pitch.ts`.

**Warum keine FFT:** Bei 4096 Samples und 48 kHz ist ein Spektrum-Bin
48000/4096 ≈ 11.7 Hz breit. Die tiefe E-Saite liegt bei 82.41 Hz, und ein
einziger Cent entspricht dort 0.048 Hz — das Spektrum wäre rund 240-mal zu grob.
Die Autokorrelation misst stattdessen die **Periodenlänge in Samples**; mit
Parabel-Interpolation um den Peak liegt die Auflösung weit unter einem Cent.

Ablauf pro Analyseblock:

1. Gleichanteil abziehen, RMS bestimmen. Unter der Noise-Gate-Schwelle
   (≈ −46 dBFS) wird „kein Signal" gemeldet statt eines Zufallswerts.
2. Autokorrelation über die FFT (Wiener-Chintschin: `r = IFFT(|FFT(x)|²)`).
   Die FFT dient hier nur als schneller Rechenweg, nicht zur Frequenzmessung —
   direkt gerechnet wäre die Autokorrelation etwa 13-mal teurer.
3. Normierung zur NSDF `n(τ) = 2·r(τ) / m(τ)`. Dadurch liegt das Ergebnis in
   [−1, 1] und ist lautstärkeunabhängig; rohes `r(τ)` fällt zu großen τ hin ab
   und provoziert Oktavfehler.
4. Das **erste** Maximum wählen, das mindestens 90 % des höchsten Maximums
   erreicht — nicht das höchste. Das ist der entscheidende Schutz gegen
   Oktavfehler, denn τ = 2·Periode korreliert fast genauso gut.
5. Peak per Parabel interpolieren → Periode → `f = Samplerate / τ`.

Danach in `src/tuner.ts`:

- **Median** über die letzten 5 Messungen. Median statt Mittelwert, weil
  einzelne Ausreißer den Mittelwert verziehen, den Median aber nicht.
- Zuordnung zur Saite mit dem kleinsten **Cent**-Abstand (nicht Hz-Abstand —
  Hz-Abstände sind im Bass eng und in der Höhe weit).
- `cents = 1200 · log₂(f_ist / f_soll)`

Aufnahmeseitig sind `echoCancellation`, `noiseSuppression` und `autoGainControl`
abgeschaltet: Sie sind für Sprache gebaut, verbiegen Pegel und fressen stehende Töne.
Ein Hochpass bei 60 Hz und ein Tiefpass bei 1200 Hz entfernen Trittschall und
dämpfen hohe Obertöne, die sonst konkurrierende Korrelations-Peaks erzeugen.

**Messwerte** (synthetische Gitarrensignale, 44.1 kHz): alle sechs Leersaiten
werden mit unter 0.05 Cent Fehler erkannt, auch bei starkem Rauschen, DC-Offset
oder schwachem Grundton. Eine Analyse kostet ca. 1.5 ms bei 40 ms Budget.

## Referenztöne

`src/reference.ts` baut eine `PeriodicWave` aus Grundton und sechs Obertönen.
Ein reiner Sinus wäre gegen eine Gitarre schwer zu hören — ihm fehlen die
Obertöne, an denen das Ohr Schwebungen festmacht. Die Hüllkurve hat eine
Attack-Rampe von 30 ms und eine Release-Rampe von 120 ms; ohne sie wäre der
Amplitudensprung eine breitbandige Sprungfunktion und deutlich als Knacken hörbar.
Es läuft immer nur ein Ton, und er endet spätestens nach 5 Sekunden.

## Aufbau

```
index.html          Seitengerüst
src/main.ts         UI-Verdrahtung und Anzeige
src/tuner.ts        Mikrofon, Filterkette, Analyse-Schleife, Glättung
src/pitch.ts        Autokorrelation / MPM  ← Audio-Mathematik
src/fft.ts          Radix-2-FFT (Rechenweg für die Autokorrelation)
src/notes.ts        Frequenzen aus Halbtonabständen, Cent-Berechnung
src/reference.ts    Referenzton-Oszillator
src/style.css       Layout (mobil, Hochformat)
```

## Fehlerfälle

Der Referenzton-Modus funktioniert in allen Fällen weiter:

| Fall                                  | Verhalten                                       |
| ------------------------------------- | ----------------------------------------------- |
| Zugriff abgelehnt (`NotAllowedError`) | Hinweis auf die Freigabe in der Adressleiste     |
| Kein Mikrofon (`NotFoundError`)       | Hinweis, Referenztöne weiter nutzbar             |
| Mikrofon belegt (`NotReadableError`)  | Hinweis auf die andere Anwendung                 |
| Kein sicherer Kontext                 | Hinweis auf HTTPS/localhost, schon vor dem Start |
| Freigabe im Browser entzogen          | Analyse stoppt sauber                            |

## Browser

Chrome, Edge, Firefox und Safari (Desktop und mobil). Der `AudioContext` wird
erst bei der ersten Nutzergeste erzeugt, wie es die Autoplay-Regeln verlangen.
