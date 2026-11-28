"""Tallest band of pure background in the feed area of 1080x2400 gray frames.

Used by android-feed-scroll.sh. Rows 380..2120 skip the header/tab strip and
the signed-out banner. A row counts as blank when it is flat and matches the
left gutter's colour; the gap between two posts is under ~110 px, so a band of
300 px or more is a row the list had not drawn yet.
"""

import sys

WIDTH = 1080
TOP, BOTTOM = 380, 2120


def tallest_band(path: str) -> int:
    data = open(path, "rb").read()
    background = data[400 * WIDTH + 8]
    best = current = 0
    for y in range(TOP, BOTTOM):
        row = data[y * WIDTH + 10 : y * WIDTH + WIDTH - 10 : 4]
        if max(row) - min(row) <= 4 and abs(row[0] - background) <= 4:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


bands = [tallest_band(path) for path in sys.argv[1:]]
print("tallest blank band per frame (px):", bands)
print("frames with a blank row (>= 300 px):", sum(b >= 300 for b in bands), "/", len(bands))
