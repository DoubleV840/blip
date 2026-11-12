#!/usr/bin/env python3
"""Generates Blip's voices: short WAV clips, one per pitch step and variant.

Every voice is synthesized from scratch (no samples), so the sounds are
original and free to ship. Run it again after editing VOICES:

    python3 tools/make_sounds.py

It writes sounds/<voice>/<variant>_<step>.wav (step 0..24, i.e. -12..+12
semitones) and hooks/voices.ts, the list the plugin reads.
"""

import math
import random
import shutil
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOUNDS = ROOT / "sounds"
VOICES_TS = ROOT / "hooks" / "voices.ts"

RATE = 22050
STEPS = 25  # -12..+12 semitones around the voice's base pitch
TARGET_RMS = 0.12
PEAK = 0.9

# Formants (F1, F2, F3) of the five vowels, for the critter voice.
VOWELS = {
    "a": (730, 1090, 2440),
    "e": (530, 1840, 2480),
    "i": (300, 2200, 2900),
    "o": (570, 840, 2410),
    "u": (320, 900, 2240),
}


def envelope(n, attack, tau):
    """Linear attack, exponential decay, and a 3 ms fade so clips never click."""
    out = []
    release = int(0.003 * RATE)
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / attack) if attack > 0 else 1.0
        env *= math.exp(-t / tau)
        if i > n - release:
            env *= (n - i) / release
        out.append(env)
    return out


def additive(n, freq_at, amp_of_harmonic):
    """Band-limited oscillator: sums harmonics below Nyquist, following freq_at(t)."""
    out = []
    phase = 0.0
    for i in range(n):
        f = freq_at(i / RATE)
        phase += 2 * math.pi * f / RATE
        top = int(0.45 * RATE / f)
        s = 0.0
        for k in range(1, top + 1):
            a = amp_of_harmonic(k)
            if a:
                s += a * math.sin(k * phase)
        out.append(s)
    return out


def square(k):
    return 4 / (math.pi * k) if k % 2 else 0.0


def pulse(duty):
    return lambda k: 2 / (math.pi * k) * math.sin(math.pi * k * duty)


def saw(k):
    return 2 / (math.pi * k) * (-1) ** (k + 1)


def sine(k):
    return 1.0 if k == 1 else 0.0


def resonator(signal, freq, bandwidth):
    """Two-pole band-pass filter: one formant."""
    r = math.exp(-math.pi * bandwidth / RATE)
    a1 = -2 * r * math.cos(2 * math.pi * freq / RATE)
    a2 = r * r
    gain = 1 - r
    y1 = y2 = 0.0
    out = []
    for x in signal:
        y = gain * x - a1 * y1 - a2 * y2
        y2, y1 = y1, y
        out.append(y)
    return out


def shape(samples, env):
    return [s * e for s, e in zip(samples, env)]


def normalize(samples):
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) or 1.0
    scale = TARGET_RMS / rms
    peak = max(abs(s) for s in samples) * scale
    if peak > PEAK:
        scale *= PEAK / peak
    return [s * scale for s in samples]


# Each voice: how it sounds (synth), its base pitch, and how far the plugin
# moves the pitch from letter to letter (spread, in semitones).


def classic(f, variant):
    n = int(0.045 * RATE)
    return shape(additive(n, lambda t: f, square), envelope(n, 0.002, 0.03))


def nes(f, variant):
    n = int(0.055 * RATE)
    return shape(additive(n, lambda t: f, pulse(0.125)), envelope(n, 0.001, 0.035))


def soft(f, variant):
    n = int(0.07 * RATE)
    tone = additive(n, lambda t: f, lambda k: {1: 1.0, 2: 0.15}.get(k, 0.0))
    return shape(tone, envelope(n, 0.006, 0.035))


def bubble(f, variant):
    n = int(0.05 * RATE)
    sweep = lambda t: f * (0.7 + 14 * t)
    return shape(additive(n, sweep, sine), envelope(n, 0.002, 0.025))


def typewriter(f, variant):
    n = int(0.035 * RATE)
    rng = random.Random(variant * 7919 + int(f))
    noise = [rng.uniform(-1, 1) for _ in range(n)]
    click = resonator(noise, f * (3.2 + variant * 0.6), 900)
    thunk = additive(n, lambda t: f / 2, sine)
    mixed = [c * 6 + 0.35 * t for c, t in zip(click, thunk)]
    return shape(mixed, envelope(n, 0.0005, 0.008 + variant * 0.002))


def robot(f, variant):
    n = int(0.065 * RATE)
    tone = additive(n, lambda t: f, saw)
    ring = [s * math.sin(2 * math.pi * f * 2.3 * i / RATE) for i, s in enumerate(tone)]
    return shape(ring, envelope(n, 0.003, 0.05))


def deep(f, variant):
    n = int(0.08 * RATE)
    tone = additive(n, lambda t: f, lambda k: square(k) if k < 8 else 0.0)
    return shape(tone, envelope(n, 0.004, 0.06))


def chirp(f, variant):
    n = int(0.032 * RATE)
    sweep = lambda t: f * (1.6 - 22 * t)
    return shape(additive(n, sweep, sine), envelope(n, 0.001, 0.02))


def critter(f, variant):
    n = int(0.075 * RATE)
    glide = lambda t: f * (1.08 - 1.6 * t)
    source = additive(n, glide, lambda k: 1 / k)
    f1, f2, f3 = list(VOWELS.values())[variant]
    voiced = [
        a + 0.8 * b + 0.25 * c
        for a, b, c in zip(
            resonator(source, f1, 90),
            resonator(source, f2, 110),
            resonator(source, f3, 150),
        )
    ]
    return shape(voiced, envelope(n, 0.008, 0.05))


VOICES = [
    # name, description, synth, base Hz, variants, spread, variants are vowels
    ("classic", "square-wave blip, the classic RPG text box", classic, 520, 1, 5, False),
    ("nes", "thin 8-bit pulse, like an old cartridge", nes, 660, 1, 5, False),
    ("soft", "gentle sine, easy on the ears", soft, 480, 1, 4, False),
    ("bubble", "little rising pops", bubble, 560, 1, 6, False),
    ("typewriter", "mechanical keys clacking", typewriter, 900, 3, 1, False),
    ("robot", "metallic, ring-modulated", robot, 170, 1, 3, False),
    ("deep", "low and ominous, boss-fight energy", deep, 130, 1, 3, False),
    ("chirp", "tiny bird chirps", chirp, 1400, 1, 7, False),
    ("critter", "a babbling little creature (vowel sounds)", critter, 260, 5, 5, True),
]


def write_wav(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)


def write_voices_ts():
    rows = "\n".join(
        f"  {{ name: '{name}', description: '{desc}', variants: {variants}, spread: {spread}, isVowels: {str(vowels).lower()} }},"
        for name, desc, _, _, variants, spread, vowels in VOICES
    )
    VOICES_TS.write_text(
        "// Generated by tools/make_sounds.py: edit the voices there, then run it again.\n\n"
        "export type Voice = {\n"
        "  name: string\n"
        "  description: string\n"
        "  variants: number\n"
        "  spread: number\n"
        "  isVowels: boolean\n"
        "}\n\n"
        f"export const PITCH_STEPS = {STEPS}\n\n"
        f"export const VOICES: readonly Voice[] = [\n{rows}\n]\n"
    )


def main():
    if SOUNDS.exists():
        shutil.rmtree(SOUNDS)
    for name, _, synth, base, variants, _, _ in VOICES:
        for variant in range(variants):
            for step in range(STEPS):
                f = base * 2 ** ((step - STEPS // 2) / 12)
                write_wav(SOUNDS / name / f"{variant}_{step}.wav", normalize(synth(f, variant)))
        print(f"{name}: {variants * STEPS} clips")
    write_voices_ts()
    print(f"wrote {VOICES_TS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
