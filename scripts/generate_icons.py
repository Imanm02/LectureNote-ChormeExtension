from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 32, 48, 128)
SCALE = 8


def point(value):
    return round(value * SCALE)


canvas = Image.new("RGBA", (point(128), point(128)), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle(
    (point(4), point(4), point(124), point(124)),
    radius=point(28),
    fill="#17202a",
)
draw.polygon(
    [(point(32), point(22)), (point(81), point(22)), (point(100), point(41)), (point(100), point(106)), (point(32), point(106))],
    fill="#fffaf5",
)
draw.line(
    [(point(32), point(22)), (point(81), point(22)), (point(100), point(41)), (point(100), point(106)), (point(32), point(106)), (point(32), point(22))],
    fill="#f97316",
    width=point(6),
    joint="curve",
)
draw.line(
    [(point(81), point(22)), (point(81), point(42)), (point(100), point(42))],
    fill="#f97316",
    width=point(6),
    joint="curve",
)
for y_value, end_value in ((56, 85), (70, 85), (84, 85)):
    start_value = 67 if y_value == 84 else 47
    draw.line(
        [(point(start_value), point(y_value)), (point(end_value), point(y_value))],
        fill="#52606d",
        width=point(6),
    )
draw.polygon(
    [(point(44), point(82)), (point(61), point(82)), (point(61), point(109)), (point(52.5), point(103)), (point(44), point(109))],
    fill="#f97316",
)

for size in SIZES:
    output = canvas.resize((size, size), Image.Resampling.LANCZOS)
    output.save(ROOT / "Images" / f"icon{size}.png", optimize=True)
