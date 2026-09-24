"""Deterministic team formation. Pure functions, no I/O.

Parties are never split. The oldest waiting party anchors a team; the team is
completed with the combination of later parties that sums to exactly 4, preferring
the FEWEST parties, then the earliest ones. If none exists the anchor waits alone
and the next-oldest party anchors. A full 4-player premade is a team by itself.
Two full teams, in queue order, make one match.

Preferring fewer parties keeps big parties from being stranded: with queue order
[2, 1, 3, 1, 2] it builds {2,2} and {1,3} instead of {2,1,1} and two leftovers.

ponytail: greedy with an O(n^3) combination search (a team needs at most 3 extra
parties), no MMR/latency/region. Fine for hundreds of queued parties; swap for a
proper solver when ranking exists. Callers only depend on the list-of-teams contract.
"""

from itertools import combinations

TEAM_SIZE = 4


def fifo(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda e: (e["joined_at"], e["queue_id"]))


def pack(entries: list[dict], team_size: int = TEAM_SIZE) -> list[list[dict]]:
    """Every entry lands in exactly one team; incomplete teams are single waiting anchors."""
    rest = fifo(entries)
    teams: list[list[dict]] = []
    while rest:
        anchor, pool = rest[0], rest[1:]
        need = team_size - anchor["size"]
        combo = next(
            (c for k in range(min(3, len(pool)) + 1) for c in combinations(pool, k) if sum(e["size"] for e in c) == need),
            None,
        )
        if combo is None:
            teams.append([anchor])
            rest = pool
            continue
        teams.append([anchor, *combo])
        used = {e["queue_id"] for e in combo}
        rest = [e for e in pool if e["queue_id"] not in used]
    return teams


def full(team: list[dict], team_size: int = TEAM_SIZE) -> bool:
    return sum(e["size"] for e in team) == team_size


def matchups(entries: list[dict]) -> list[tuple[list[dict], list[dict]]]:
    ready = [t for t in pack(entries) if full(t)]
    return [(ready[i], ready[i + 1]) for i in range(0, len(ready) - 1, 2)]


if __name__ == "__main__":  # self-check: python -m app.services.packing
    def e(i, size):
        return {"queue_id": f"q{i}", "joined_at": i, "size": size}

    def sizes(teams):
        return [[x["size"] for x in t] for t in teams]

    # Spec example: 1 + 2 + 1 combine into one team of 4.
    assert sizes(pack([e(0, 1), e(1, 2), e(2, 1)])) == [[1, 2, 1]]
    # Full premade stays together, never merged or split.
    assert sizes(pack([e(0, 3), e(1, 4), e(2, 1)])) == [[3, 1], [4]]
    # Fewest-parties rule avoids stranding: [2,1,3,1,2] -> {2,2} + {1,3}, leftover 1.
    assert sizes(pack([e(0, 2), e(1, 1), e(2, 3), e(3, 1), e(4, 2)])) == [[2, 2], [1, 3], [1]]
    # 8 players make exactly one match; a 9th waits.
    ms = matchups([e(0, 2), e(1, 2), e(2, 4), e(3, 1)])
    assert len(ms) == 1 and sum(x["size"] for t in ms[0] for x in t) == 8
    assert matchups([e(0, 3), e(1, 3)]) == []
    # Solo random queue: 8 solos -> one match.
    assert len(matchups([e(i, 1) for i in range(8)])) == 1
    print("packing ok")
