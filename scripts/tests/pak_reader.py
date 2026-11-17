"""Reader plugin for the synthetic container of test_loaded.py: per record a u8 id, a u8 size and that many bytes."""


def records(data: bytes, name: str) -> dict[int, bytes]:
    out: dict[int, bytes] = {}
    i = 0
    while i < len(data):
        if i + 2 > len(data) or i + 2 + data[i + 1] > len(data):
            raise ValueError(f"record cut off at {i}")
        out[data[i]] = data[i + 2:i + 2 + data[i + 1]]
        i += 2 + data[i + 1]
    return out
