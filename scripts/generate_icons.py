from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 32, 48, 128)
SCALE = 8


def point(value):
    return round(value * SCALE)


def rounded_line(draw, start, end, *, fill, width):
    start_point = (point(start[0]), point(start[1]))
    end_point = (point(end[0]), point(end[1]))
    line_width = point(width)
    radius = line_width / 2
    draw.line([start_point, end_point], fill=fill, width=line_width)
    for x_value, y_value in (start_point, end_point):
        draw.ellipse(
            (x_value - radius, y_value - radius, x_value + radius, y_value + radius),
            fill=fill,
        )


canvas = Image.new("RGBA", (point(128), point(128)), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle(
    (point(16.5), point(16.5), point(111.5), point(111.5)),
    radius=point(21.5),
    fill="#17202a",
    outline="#3a4a5c",
    width=point(1),
)
draw.polygon(
    [(point(38), point(30)), (point(78), point(30)), (point(93), point(46)), (point(93), point(98)), (point(38), point(98))],
    fill="#fffaf5",
)
draw.line(
    [(point(38), point(30)), (point(78), point(30)), (point(93), point(46)), (point(93), point(98)), (point(38), point(98)), (point(38), point(30))],
    fill="#f97316",
    width=point(5),
    joint="curve",
)
draw.line(
    [(point(78), point(30)), (point(78), point(46)), (point(93), point(46))],
    fill="#f97316",
    width=point(5),
    joint="curve",
)
for y_value, start_value, end_value in ((58, 50, 81), (69, 50, 81), (80, 66, 81)):
    rounded_line(
        draw,
        (start_value, y_value),
        (end_value, y_value),
        fill="#52606d",
        width=5,
    )
draw.polygon(
    [(point(48), point(78)), (point(62), point(78)), (point(62), point(100)), (point(55), point(95)), (point(48), point(100))],
    fill="#f97316",
)

for size in SIZES:
    output = canvas.resize((size, size), Image.Resampling.LANCZOS)
    padding = round(size / 8)
    pixels = output.load()
    for y_value in range(size):
        for x_value in range(size):
            if not (padding <= x_value < size - padding and padding <= y_value < size - padding):
                pixels[x_value, y_value] = (0, 0, 0, 0)
    output.save(ROOT / "Images" / f"icon{size}.png", optimize=True)
