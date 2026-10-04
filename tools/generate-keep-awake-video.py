#!/usr/bin/env python3
"""Generate the Dashboard's keep-awake "ON" lamp loop (issue #246).

The Dashboard keeps the machine awake by playing a tiny muted video on a
loop — the browser trick that actually defeats a corporate sleep policy — and
that same video IS the big "ON" light in the top-right corner, so the
buffoonery is visible rather than hidden offscreen.

The encoded loops are committed to the repo (`src/dashboard/assets/`), so this
script only has to be re-run when the lamp's look changes. It needs Pillow and
GStreamer (`gst-launch-1.0` with the `vpx`, `x264`, `png` and `matroska`
plugins); neither is a dependency of Yoke itself.

    python3 tools/generate-keep-awake-video.py
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

# Square source; the lamp is rendered as a circle roughly half this wide, so
# 160px keeps it crisp on a HiDPI display without bloating the file.
SIZE = 160
FPS = 20
FRAMES = 40  # 2 s — one full breath of the pulse

BACKGROUND = (10, 12, 11)
GLOW = (0, 255, 136)     # --color-green
CORE = (190, 255, 224)   # near-white heart of the lamp

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "src" / "dashboard" / "assets"


def _palette() -> list[int]:
    """256-entry intensity → RGB ramp: background → glow green → near-white."""
    ramp: list[int] = []
    for v in range(256):
        i = v / 255.0
        if i <= 0.75:
            t, a, b = i / 0.75, BACKGROUND, GLOW
        else:
            t, a, b = (i - 0.75) / 0.25, GLOW, CORE
        ramp.extend(int(a[c] + (b[c] - a[c]) * t) for c in range(3))
    return ramp


PALETTE = _palette()


def lamp_frame(phase: float) -> Image.Image:
    """Render one frame of the breathing lamp. `phase` is 0..1 over the loop."""
    # Sine over the whole loop, so the last frame wraps seamlessly onto the first.
    breath = 0.5 - 0.5 * math.cos(2 * math.pi * phase)
    radius = 0.34 + 0.08 * breath      # flat-bright core, as a fraction of the radius
    falloff = 2.4 - 0.7 * breath       # softer halo at the top of the breath
    brightness = 0.70 + 0.30 * breath

    # Pillow's radial gradient is a 256x256 L image, 0 at the centre and 255 at
    # half-width, so the pixel value IS the distance from the centre scaled to
    # the inscribed circle. A lookup table turns it into glow intensity without
    # needing numpy.
    lut = []
    for v in range(256):
        d = v / 255.0
        if d <= radius:
            intensity = 1.0
        else:
            t = min(1.0, (d - radius) / (1.0 - radius))
            intensity = (1.0 - t) ** falloff
        lut.append(int(round(255 * intensity * brightness)))

    gradient = Image.radial_gradient("L").resize((SIZE, SIZE), Image.BICUBIC)
    intensity = gradient.point(lut)

    # Paint through the palette rather than per-pixel Python arithmetic.
    frame = Image.frombytes("P", (SIZE, SIZE), intensity.tobytes())
    frame.putpalette(PALETTE)
    return frame.convert("RGB")


def encode(frame_dir: Path, pipeline_tail: str, out_file: Path) -> None:
    pipeline = (
        f'multifilesrc location={frame_dir}/f%04d.png index=0 '
        f'caps=image/png,framerate={FPS}/1 ! pngdec ! videoconvert ! '
        f'video/x-raw,format=I420 ! {pipeline_tail} ! '
        f'filesink location={out_file}'
    )
    subprocess.run(
        ["gst-launch-1.0", "-q", "-e", *pipeline.split()],
        check=True,
    )


def main() -> int:
    if shutil.which("gst-launch-1.0") is None:
        print("gst-launch-1.0 not found — install GStreamer to regenerate the loop", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        frame_dir = Path(tmp)
        for i in range(FRAMES):
            lamp_frame(i / FRAMES).save(frame_dir / f"f{i:04d}.png")

        # VP8/WebM for Chrome, Firefox and Edge; H.264/MP4 for Safari and any
        # browser build without the VP8 decoder.
        encode(
            frame_dir,
            "vp8enc deadline=1 cpu-used=0 end-usage=cq cq-level=28 "
            f"target-bitrate=48000 keyframe-max-dist={FRAMES} ! webmmux",
            OUT_DIR / "keep-awake.webm",
        )
        encode(
            frame_dir,
            "x264enc bitrate=48 speed-preset=veryslow tune=stillimage "
            f"key-int-max={FRAMES} ! video/x-h264,profile=baseline ! mp4mux faststart=true",
            OUT_DIR / "keep-awake.mp4",
        )

    for f in sorted(OUT_DIR.glob("keep-awake.*")):
        print(f"{f.relative_to(REPO_ROOT)}: {f.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
