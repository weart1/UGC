"""Prints a timestamped transcript of a media file. Used to read what is said in a reference ad.

Needs `pip install faster-whisper`; the model size comes from WHISPER_MODEL (default: base).
"""
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], vad_filter=True)
for s in segments:
    print(f"[{s.start:.1f}-{s.end:.1f}s] {s.text.strip()}")
