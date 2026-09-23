"""Deterministic team formation. Pure functions, no I/O.

Parties are never split. Entries are taken FIFO (joined_at, then queue_id) and
placed first-fit into the earliest team with room. A full 4-player premade
therefore always forms its own team; smaller parties combine.
Two full teams, in order, make one match.

ponytail: first-fit FIFO, no MMR/latency/region. Swap `pack` for a smarter
bin-packer when ranking exists; callers only need the list-of-teams contract.
"""

TEAM_SIZE = 4


def fifo(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda e: (e["joined_at"], e["queue_id"]))


def pack(entries: list[dict], team_size: int = TEAM_SIZE) -> list[list[dict]]:
    teams: list[list[dict]] = []
    for e in fifo(entries):
        for t in teams:
            if sum(x["size"] for x in t) + e["size"] <= team_size:
                t.append(e)
                break
        else:
            teams.append([e])
    return teams


def full(team: list[dict], team_size: int = TEAM_SIZE) -> bool:
    return sum(e["size"] for e in team) == team_size


def matchups(entries: list[dict]) -> list[tuple[list[dict], list[dict]]]:
    ready = [t for t in pack(entries) if full(t)]
    return [(ready[i], ready[i + 1]) for i in range(0, len(ready) - 1, 2)]


if __name__ == "__main__":  # self-check: python -m app.services.packing
    def e(i, size):
        return {"queue_id": f"q{i}", "joined_at": i, "size": size}

    # Spec example: 1 + 2 + 1 combine into one team of 4.
    teams = pack([e(0, 1), e(1, 2), e(2, 1)])
    assert [[x["queue_id"] for x in t] for t in teams] == [["q0", "q1", "q2"]]
    # Full premade stays together, never merged or split.
    teams = pack([e(0, 3), e(1, 4), e(2, 1)])
    assert [[x["size"] for x in t] for t in teams] == [[3, 1], [4]]
    # 8 players make exactly one match; a 9th waits.
    ms = matchups([e(0, 2), e(1, 2), e(2, 4), e(3, 1)])
    assert len(ms) == 1 and sum(x["size"] for t in ms[0] for x in t) == 8
    assert matchups([e(0, 3), e(1, 3)]) == []
    print("packing ok")
