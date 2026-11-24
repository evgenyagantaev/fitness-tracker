#!/usr/bin/env python3
"""
Generates offline Russian female radio-style voice clips (Silero v5_1_ru xenia + radio_fx)
from the Java VoiceClips inventory into android/native/app/src/main/assets/voice/ (gitignored).

Silero ru models are CC BY-NC-SA 4.0 (personal/non-commercial use; weights & derived clips stay out of git).
"""
from __future__ import annotations
import argparse, collections, os, re, subprocess, sys, tempfile, time, warnings
warnings.filterwarnings('ignore')

import numpy as np
import torch

from lexicon import LEX, stress
import radio_fx as fx

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
JAVA_SRC = os.path.join(REPO, 'android', 'native', 'app', 'src', 'main', 'java', 'tech', 'agantay', 'fitness')
DEFAULT_OUT = os.path.join(REPO, 'android', 'native', 'app', 'src', 'main', 'assets', 'voice')
DEFAULT_MODEL = '/workspace/silero/v5_1_ru.pt'


def dump_inventory() -> list[tuple[str, str, str]]:
    with tempfile.TemporaryDirectory() as td:
        files = [os.path.join(JAVA_SRC, n) for n in ('RuNum.java', 'RunPhrases.java', 'VoiceClips.java')]
        subprocess.run(['javac', '-d', td, '-encoding', 'UTF-8', *files], check=True)
        out = subprocess.run(['java', '-cp', td, 'tech.agantay.fitness.VoiceClips'],
                             check=True, capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        kind, key, text = line.split('\t', 2)
        rows.append((kind, key, text))
    return rows


def check_lexicon(rows: list[tuple[str, str, str]]) -> None:
    missing = set()
    for _, _, text in rows:
        for w in re.findall(r'[А-Яа-яЁё]+', text.lower()):
            if w not in LEX:
                missing.add(w)
    if missing:
        raise SystemExit(f'Missing words in lexicon.py: {sorted(missing)}')


def synth_clean(model, spk: str, text: str) -> np.ndarray:
    marked = stress(text)
    kw = dict(put_stress_homo=False, put_yo_homo=False) if 'put_stress_homo' in model.apply_tts.__code__.co_varnames else {}
    w = model.apply_tts(text=marked, speaker=spk, sample_rate=SR, put_accent=False, put_yo=True, **kw)
    w = np.asarray(w, dtype=np.float32)
    a = np.abs(w)
    thr = 0.01 * (a.max() or 1.0)
    idx = np.where(a > thr)[0]
    if len(idx):
        pad = int(0.025 * SR)
        w = w[max(0, idx[0] - pad):min(len(w), idx[-1] + pad)]
    return w


def env_rms(w: np.ndarray, ms: float = 10.0) -> np.ndarray:
    n = max(1, int(SR * ms / 1000.0))
    return np.sqrt(np.convolve(w ** 2, np.ones(n, dtype=np.float32) / n, 'same'))


def snap_min(w: np.ndarray, t_sec: float, rad_s: float = 0.06) -> int:
    e = env_rms(w, 10.0)
    c = int(t_sec * SR)
    lo = max(0, c - int(rad_s * SR))
    hi = min(len(w), c + int(rad_s * SR))
    return lo + int(np.argmin(e[lo:hi]))


def cut_after_minutes(wm, w_clean: np.ndarray, text: str, fallbacks: list[str]) -> int:
    # faster-whisper expects 16 kHz float32
    x16 = np.interp(np.arange(0, len(w_clean), SR / 16000.0), np.arange(len(w_clean)), w_clean).astype(np.float32)
    segs, _ = wm.transcribe(x16, language='ru', word_timestamps=True, beam_size=5)
    words = [(z.word.strip().lower(), z.start, z.end) for seg in segs for z in (seg.words or [])]
    idx = [i for i, x in enumerate(words) if x[0].startswith('минут')]
    if idx and idx[0] + 1 < len(words):
        i = idx[0]
        t_mid = (words[i][2] + words[i + 1][1]) / 2.0
        return snap_min(w_clean, t_mid, 0.07)
    # fallback: proportional position after "минут..."
    tl = text.lower()
    k = tl.index('минут')
    k = tl.index(' ', k) + 1
    fallbacks.append(text)
    return snap_min(w_clean, (len(w_clean) / SR) * (k / len(tl)), 0.14)


def save_opus_ogg(x: np.ndarray, dst: str, br: str = '24k') -> None:
    x = np.ascontiguousarray(np.clip(x, -1.0, 1.0).astype(np.float32))
    tmp = dst + '.tmp.ogg'
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', 'pipe:0',
         '-ac', '1', '-c:a', 'libopus', '-b:a', br, '-application', 'voip', tmp],
        input=x.tobytes(), check=True)
    os.replace(tmp, dst)


def make_loopable_hiss(dur_s: float = 4.0) -> np.ndarray:
    rng = np.random.default_rng(7)
    n = int(dur_s * SR)
    ov = int(0.15 * SR)
    raw = fx.hiss(n + ov, SR, rng, rms=0.028)
    head = raw[:n].copy()
    tail = raw[n:]
    t = np.linspace(0.0, np.pi / 2.0, ov, dtype=np.float32)
    head[:ov] = head[:ov] * np.sin(t) + tail * np.cos(t)
    return head


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--speaker', default='xenia')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--limit', type=int, default=0, help='render only N clips (debug)')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    rows = dump_inventory()
    check_lexicon(rows)
    if args.limit:
        rows = rows[:args.limit]
    os.makedirs(args.out, exist_ok=True)

    model = torch.package.PackageImporter(args.model).load_pickle('tts_models', 'model')
    from faster_whisper import WhisperModel
    wm = WhisperModel('small', compute_type='int8')

    hiss_path = os.path.join(args.out, 'hiss_bed.ogg')
    if args.force or not os.path.exists(hiss_path):
        save_opus_ogg(make_loopable_hiss(4.0), hiss_path, br='24k')

    t0 = time.time()
    fallbacks: list[str] = []
    rendered = 0
    for kind, key, text in rows:
        dst = os.path.join(args.out, f'{key}.ogg')
        if not args.force and os.path.exists(dst):
            continue
        clean = synth_clean(model, args.speaker, text)
        # Apply chain_A BEFORE cutting A/B carriers so filter/compressor state is seamless at the join
        proc = fx.chain_A(clean, SR)
        if kind == 'W':
            seg = proc
        elif kind == 'A':
            cut = cut_after_minutes(wm, clean, text, fallbacks)
            seg = proc[:cut]
        elif kind == 'B':
            cut = cut_after_minutes(wm, clean, text, fallbacks)
            seg = proc[cut:]
        else:
            raise ValueError(kind)
        save_opus_ogg(seg, dst, br='24k')
        rendered += 1
        if rendered % 100 == 0:
            print(f'  {rendered}/{len(rows)} clips ({time.time() - t0:.0f}s)', flush=True)

    counts = collections.Counter(k.split('.')[0] for _, k, _ in rows)
    total_bytes = sum(os.path.getsize(os.path.join(args.out, f)) for f in os.listdir(args.out) if f.endswith('.ogg'))
    print(f'done: {len(rows)} inventory clips ({rendered} new) in {time.time() - t0:.1f}s; '
          f'fallback cuts={len(fallbacks)}; total={total_bytes / 1e6:.2f} MB; groups={dict(counts)}')
    if fallbacks:
        print('fallback sample:', fallbacks[:5])


if __name__ == '__main__':
    main()
