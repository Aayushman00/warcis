"""Minimal ARCLINE API client used by e2e.py and bots.py (goes through the public gateway)."""

import os

import httpx

API = os.environ.get("API_URL", "http://localhost:8000/api")


class ApiFail(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code = status, code


class Client:
    def __init__(self, token: str | None = None):
        self.token = token
        self.me: dict = {}
        self.http = httpx.Client(base_url=API, timeout=10)

    def call(self, method: str, path: str, json: dict | None = None):
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        r = self.http.request(method, path, json=json, headers=headers)
        if r.status_code >= 400:
            err = r.json().get("error", {})
            raise ApiFail(r.status_code, err.get("code", "?"), err.get("message", ""))
        return r.json() if r.content else None

    def register(self, username: str, password: str) -> "Client":
        s = self.call("POST", "/auth/register", {"username": username, "email": f"{username}@arcline.test", "password": password})
        self.token, self.me = s["token"], s["user"]
        return self

    def login(self, login: str, password: str) -> "Client":
        s = self.call("POST", "/auth/login", {"login": login, "password": password})
        self.token, self.me = s["token"], s["user"]
        return self

    def login_or_register(self, username: str, password: str) -> "Client":
        try:
            return self.login(username, password)
        except ApiFail as e:
            if e.status != 401:
                raise
            return self.register(username, password)

    # convenience
    def state(self):
        return self.call("GET", "/social/state")

    def status(self):
        return self.call("GET", "/matchmaking/status")

    def befriend(self, other: "Client") -> None:
        r = self.call("POST", "/social/friend-requests", {"username": other.me["name"]})
        if r["status"] == "pending":
            req = next(x for x in other.state()["requests"]["incoming"] if x["user"]["id"] == self.me["id"])
            other.call("POST", f"/social/friend-requests/{req['id']}/accept")

    def invite_and_join(self, other: "Client") -> None:
        self.call("POST", "/social/party/invitations", {"user_id": other.me["id"]})
        inv = next(i for i in other.state()["invitations"] if i["from"]["id"] == self.me["id"])
        other.call("POST", f"/social/invitations/{inv['id']}/accept")
