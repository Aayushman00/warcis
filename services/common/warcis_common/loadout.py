"""Class and weapon identifiers shared by matchmaking-service (lobby validation) and game-service.

IDs only. Balance numbers live in game-service/app/sim.py, the only place that simulates them.
Self-check: python -m warcis_common.loadout (from services/common)
"""

CLASSES = ("ASSAULTER", "GUARDIAN", "ASSASSIN")
WEAPONS = ("ASSAULT_RIFLE", "SHOTGUN", "SNIPER_RIFLE")
DEFAULT_LOADOUT = {"class": "ASSAULTER", "weapon": "ASSAULT_RIFLE"}


def valid(d) -> bool:
    return isinstance(d, dict) and d.get("class") in CLASSES and d.get("weapon") in WEAPONS


if __name__ == "__main__":
    assert valid(DEFAULT_LOADOUT)
    assert all(valid({"class": c, "weapon": w}) for c in CLASSES for w in WEAPONS)  # classes and weapons are independent
    for bad in (None, {}, {"class": "ASSAULTER"}, {"weapon": "SHOTGUN"}, {"class": "NOPE", "weapon": "SHOTGUN"},
                {"class": "GUARDIAN", "weapon": "BAZOOKA"}, {"class": ["GUARDIAN"], "weapon": "SHOTGUN"}, "GUARDIAN"):
        assert not valid(bad), bad
    print("loadout ok")
