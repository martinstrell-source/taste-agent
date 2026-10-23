"""Decode the location embedded in a Google Maps feature id (0x<cell>:0x<cid>).

The first 64-bit number is an S2 cell id at the place's location. Decoding it gives
coordinates accurate to a few meters, with no API call. The second number is the CID.
"""
import math

_SWAP, _INVERT = 1, 2
_POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]]
_POS_TO_ORIENT = [_SWAP, 0, 0, _INVERT | _SWAP]
_LOOKUP_IJ = [0] * 1024


def _init(level, i, j, orig, pos, orient):
    if level == 4:
        _LOOKUP_IJ[(pos << 2) + orig] = (i << 6) + (j << 2) + orient
        return
    level += 1
    i <<= 1; j <<= 1; pos <<= 2
    r = _POS_TO_IJ[orient]
    for idx in range(4):
        _init(level, i + (r[idx] >> 1), j + (r[idx] & 1), orig, pos + idx, orient ^ _POS_TO_ORIENT[idx])


for _o in range(4):
    _init(0, 0, 0, _o, 0, _o)


def _st_to_uv(s):
    return (4 * s * s - 1) / 3 if s >= 0.5 else (1 - 4 * (1 - s) ** 2) / 3


def cell_to_latlng(cell_id: int):
    face = cell_id >> 61
    bits = face & 1
    i = j = 0
    for k in range(7, -1, -1):
        nbits = 2 if k == 7 else 4
        bits += ((cell_id >> (k * 8 + 1)) & ((1 << (2 * nbits)) - 1)) << 2
        bits = _LOOKUP_IJ[bits]
        i += (bits >> 6) << (k * 4)
        j += ((bits >> 2) & 15) << (k * 4)
        bits &= 3
    u = _st_to_uv((2 * i + 1) / (1 << 31))
    v = _st_to_uv((2 * j + 1) / (1 << 31))
    x, y, z = [(1, u, v), (-u, 1, v), (-u, -v, 1), (-1, -v, -u), (v, -1, -u), (v, u, -1)][face]
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def feature_id_to_latlng(feature_id: str):
    """'0x808f7fa2d9ceba0f:0xdc228d362f0016f2' -> (lat, lng), or None if unparseable."""
    try:
        return cell_to_latlng(int(feature_id.split(":")[0], 16))
    except (ValueError, AttributeError, IndexError):
        return None


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
