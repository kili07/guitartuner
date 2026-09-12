/**
 * Minimale In-Place-FFT (iterativer Radix-2 Cooley-Tukey).
 *
 * Wird hier NICHT zur Tonhöhenerkennung per Spektrum benutzt – dafür wäre die
 * Frequenzauflösung bei 82 Hz viel zu grob. Sie dient ausschließlich als
 * schneller Rechenweg für die Autokorrelation (siehe pitch.ts):
 * eine direkte Autokorrelation über 8192 Samples und ~800 Lags kostet ~6.5 Mio
 * Multiplikationen pro Frame, der FFT-Weg nur ~2 x N log2(N) ≈ 0.5 Mio.
 */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT-Größe muss eine Zweierpotenz sein, war ${size}`);
    }
    this.size = size;
    const levels = Math.round(Math.log2(size));

    // Bit-Reversal-Permutation vorberechnen.
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      this.rev[i] = r;
    }

    // Twiddle-Faktoren e^(2πi k / N) vorberechnen.
    const half = size >> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  /**
   * Transformiert re/im in-place.
   * Vorwärts: X[k] = Σ x[n] · e^(-2πi·kn/N)
   * Invers:   x[n] = (1/N) Σ X[k] · e^(+2πi·kn/N)
   */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;

    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    // Vorzeichen des Imaginärteils der Twiddles: -1 vorwärts, +1 invers.
    const sign = inverse ? 1 : -1;

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const wr = this.cosTable[k];
          const wi = sign * this.sinTable[k];
          const ar = re[j + half];
          const ai = im[j + half];
          const tr = ar * wr - ai * wi;
          const ti = ar * wi + ai * wr;
          re[j + half] = re[j] - tr;
          im[j + half] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}
