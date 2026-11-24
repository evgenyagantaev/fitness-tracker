#!/usr/bin/env python3
"""Radio-style post-FX for run announcements (Silero clips).

Variants (applied to a clean mono phrase, then optionally concatenated):
  A  narrower band ~400–3000 Hz, stronger compression, light saturation
  B  A + faint band-limited hiss under the speech
  C  B + short PTT click at the start and a squelch tail at the end

CLI:
  radio_fx.py A|B|C input.wav|mp3 output.mp3
  radio_fx.py A|B|C --dir DIR --all ALL.mp3 [--out-dir DIR] [--gap 0.7]

Keep this as the single effect chain for the full clip inventory later.
"""
from __future__ import annotations
import argparse, os, subprocess, sys, tempfile
import numpy as np
from scipy.signal import butter, sosfilt, sosfiltfilt

SR_OUT = 48000

def load(path, sr=SR_OUT):
    raw = subprocess.run(
        ['ffmpeg','-loglevel','error','-i',path,'-ac','1','-ar',str(sr),'-f','f32le','-'],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()

def save_mp3(x, path, sr=SR_OUT, br='64k'):
    x = np.ascontiguousarray(np.clip(x, -1, 1).astype(np.float32))
    subprocess.run(
        ['ffmpeg','-y','-loglevel','error','-f','f32le','-ar',str(sr),'-ac','1','-i','pipe:0',
         '-ac','1','-b:a',br,path],
        input=x.tobytes(), check=True)

def butter_bp(lo, hi, sr, order=4):
    return butter(order, [lo, hi], btype='band', fs=sr, output='sos')

def bandpass(x, sr, lo=400, hi=3000):
    return sosfiltfilt(butter_bp(lo, hi, sr), x).astype(np.float32)

def peak_env(x, sr, atk_ms=5, rel_ms=50):
    a = np.abs(x)
    atk = 1 - np.exp(-1 / (sr * atk_ms / 1000))
    rel = 1 - np.exp(-1 / (sr * rel_ms / 1000))
    e = np.empty_like(a)
    acc = 0.0
    for i, v in enumerate(a):
        coef = atk if v > acc else rel
        acc = acc + coef * (v - acc)
        e[i] = acc
    return e

def compress(x, sr, thresh=0.10, ratio=7.0, atk_ms=4, rel_ms=55, makeup=1.55):
    e = peak_env(x, sr, atk_ms, rel_ms)
    # gain = 1 below thresh; above, (e/thresh)**(1/ratio - 1)
    g = np.ones_like(e)
    over = e > thresh
    g[over] = (e[over] / thresh) ** (1 / ratio - 1)
    return (x * g * makeup).astype(np.float32)

def saturate(x, drive=1.8):
    # gentle tanh, then bring peak back a little
    y = np.tanh(drive * x) / np.tanh(drive)
    return y.astype(np.float32)

def limiter(x, ceiling=0.89):
    p = np.max(np.abs(x)) or 1.0
    if p > ceiling:
        x = x * (ceiling / p)
    return x.astype(np.float32)

def presence(x, sr, f=1600, gain_db=2.0, q=1.1):
    # peaking EQ via biquad
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f / sr
    alpha = np.sin(w0) / (2 * q)
    b0 = 1 + alpha * A
    b1 = -2 * np.cos(w0)
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * np.cos(w0)
    a2 = 1 - alpha / A
    b = np.array([b0, b1, b2]) / a0
    a = np.array([1, a1 / a0, a2 / a0])
    # sos: [b0,b1,b2,1,a1,a2]
    sos = np.array([[b[0], b[1], b[2], 1, a[1], a[2]]])
    return sosfiltfilt(sos, x).astype(np.float32)

def pinkish(n, rng):
    spec = rng.normal(0, 1, n // 2 + 1) + 1j * rng.normal(0, 1, n // 2 + 1)
    f = np.fft.rfftfreq(n)
    spec[1:] /= np.maximum(f[1:] ** 0.5, 1e-9)
    spec[0] = 0
    y = np.fft.irfft(spec, n).astype(np.float32)
    y /= (np.max(np.abs(y)) or 1)
    return y

def hiss(n, sr, rng, rms=0.018):
    y = bandpass(pinkish(n, rng), sr, 500, 2800)
    cur = np.sqrt(np.mean(y ** 2)) or 1
    return (y * (rms / cur)).astype(np.float32)

def click(sr, rng):
    """Short PTT press: a tight transient + brief squelch burst (~70 ms)."""
    n = int(0.070 * sr)
    t = np.arange(n) / sr
    # metallic tick: decaying 1.8 kHz + a bit of 3 kHz, plus noise burst
    env = np.exp(-t / 0.012)
    tone = 0.55 * np.sin(2 * np.pi * 1800 * t) * env
    tone += 0.18 * np.sin(2 * np.pi * 2650 * t) * np.exp(-t / 0.008)
    burst = hiss(n, sr, rng, rms=0.15) * np.exp(-t / 0.025)
    # opening rustle that settles
    open_n = n
    y = tone + burst
    # 15 ms fade in so it isn't a nasty spike in earbuds
    fade = np.linspace(0, 1, int(0.008 * sr), dtype=np.float32)
    y[:len(fade)] *= fade
    return limiter(y.astype(np.float32), 0.78)

def tail(sr, rng):
    """Squelch close: ~160 ms of band-limited noise that drops off."""
    n = int(0.160 * sr)
    t = np.arange(n) / sr
    # a little up-front burst then exponential close
    env = np.exp(-t / 0.045) * (1 - np.exp(-t / 0.008))
    y = hiss(n, sr, rng, rms=0.11) * env.astype(np.float32)
    # faint downward chirp (squelch)
    chirp = 0.12 * np.sin(2 * np.pi * (2200 - 900 * t / t[-1]) * t) * np.exp(-t / 0.03)
    y = y + chirp.astype(np.float32)
    fade = np.linspace(1, 0, int(0.04 * sr), dtype=np.float32)
    y[-len(fade):] *= fade
    return limiter(y.astype(np.float32), 0.55)

def chain_A(x, sr):
    y = bandpass(x, sr, 400, 3000)
    y = presence(y, sr, 1550, 2.0, 1.0)
    y = compress(y, sr, thresh=0.09, ratio=7.5, atk_ms=4, rel_ms=50, makeup=1.7)
    y = saturate(y, drive=1.85)
    y = bandpass(y, sr, 380, 3100)   # tidy harmonics from saturation
    return limiter(y, 0.88)

def apply(variant, x, sr, rng=None):
    variant = variant.upper()
    if rng is None:
        rng = np.random.default_rng(7)
    # trim tiny leading/trailing silence so PTT sits tight against speech,
    # but leave a few ms so the first consonant isn't clipped after the filter
    a = np.abs(x)
    thr = 0.01 * (a.max() or 1)
    idx = np.where(a > thr)[0]
    if len(idx):
        pad = int(0.025 * sr)
        x = x[max(0, idx[0] - pad): min(len(x), idx[-1] + pad)]
    y = chain_A(x, sr)
    if variant == 'A':
        return y
    h = hiss(len(y), sr, rng, rms=0.028)
    # hiss follows the speech a little, with a quiet floor so the bed is constant
    e = peak_env(y, sr, 8, 80)
    e = e / (e.max() or 1)
    bed = h * (0.45 + 0.55 * e)
    y = limiter(y + bed, 0.88)
    if variant == 'B':
        return y
    if variant != 'C':
        raise ValueError('variant must be A, B or C')
    pre = click(sr, rng)
    post = tail(sr, rng)
    # 20 ms of hiss bridging click → speech and speech → tail
    bridge = int(0.018 * sr)
    mid = y
    # fade the joints
    if len(mid) > bridge:
        mid[:bridge] *= np.linspace(0.7, 1, bridge, dtype=np.float32)
        mid[-bridge:] *= np.linspace(1, 0.7, bridge, dtype=np.float32)
    gap = hiss(bridge, sr, rng, rms=0.02)
    return limiter(np.concatenate([pre, gap, mid, gap, post]), 0.90)

def process_file(variant, src, dst, rng=None):
    y = apply(variant, load(src), SR_OUT, rng)
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or '.', exist_ok=True)
    save_mp3(y, dst)
    return y

def process_dir(variant, src_dir, all_path, out_dir=None, gap_s=0.65, pattern=None):
    files = sorted(f for f in os.listdir(src_dir) if f.lower().endswith(('.mp3','.wav','.ogg')))
    if pattern:
        import fnmatch
        files = [f for f in files if fnmatch.fnmatch(f, pattern)]
    rng = np.random.default_rng(11)
    parts = []
    gap = np.zeros(int(gap_s * SR_OUT), np.float32)
    for i, f in enumerate(files):
        y = apply(variant, load(os.path.join(src_dir, f)), SR_OUT, rng)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            save_mp3(y, os.path.join(out_dir, os.path.splitext(f)[0] + '.mp3'))
        parts.append(y)
        if i < len(files) - 1:
            parts.append(gap)
    whole = np.concatenate(parts) if parts else np.zeros(1, np.float32)
    os.makedirs(os.path.dirname(os.path.abspath(all_path)) or '.', exist_ok=True)
    save_mp3(whole, all_path)
    return files

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('variant', choices=['A','B','C','a','b','c'])
    p.add_argument('src', nargs='?', help='input wav/mp3, or use --dir')
    p.add_argument('dst', nargs='?', help='output mp3')
    p.add_argument('--dir', dest='indir', help='directory of phrase clips (clean)')
    p.add_argument('--all', dest='allpath', help='concatenated output mp3')
    p.add_argument('--out-dir', dest='outdir', help='also write per-phrase mp3s')
    p.add_argument('--gap', type=float, default=0.65, help='silence between phrases in ALL, seconds')
    args = p.parse_args()
    v = args.variant.upper()
    if args.indir:
        if not args.allpath:
            p.error('--dir requires --all')
        files = process_dir(v, args.indir, args.allpath, args.outdir, args.gap)
        print(v, 'phrases', len(files), '->', args.allpath)
    else:
        if not (args.src and args.dst):
            p.error('src dst, or --dir + --all')
        process_file(v, args.src, args.dst)
        print(v, args.src, '->', args.dst)

if __name__ == '__main__':
    main()
