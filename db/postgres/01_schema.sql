-- WARCIS relational schema.
-- One PostgreSQL instance, one schema per owning service:
--   auth.*   owned (written) by auth-service
--   social.* owned (written) by party-service; it may READ auth.users for display/status.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS social;

-- ───────────────────────── auth ─────────────────────────

CREATE TABLE auth.users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      varchar(16)  NOT NULL CHECK (username ~ '^[A-Za-z0-9_.-]{3,16}$'),
    tag           char(4)      NOT NULL CHECK (tag ~ '^[0-9]{4}$'),
    email         varchar(254) NOT NULL,
    password_hash text         NOT NULL,
    status_pref   varchar(8)   NOT NULL DEFAULT 'online' CHECK (status_pref IN ('online', 'away')),
    last_seen     timestamptz,                 -- NULL = signed out; stale = offline
    created_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_ci ON auth.users (lower(username));
CREATE UNIQUE INDEX users_email_ci    ON auth.users (lower(email));

-- ───────────────────────── social: friends ─────────────────────────

CREATE TABLE social.friend_requests (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    to_user    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status     varchar(9) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_user <> to_user)
);
-- At most one open request per direction.
CREATE UNIQUE INDEX friend_requests_one_pending ON social.friend_requests (from_user, to_user) WHERE status = 'pending';

-- Undirected friendship stored once, canonical order user_a < user_b.
CREATE TABLE social.friendships (
    user_a     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_b     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);
CREATE INDEX friendships_b ON social.friendships (user_b);

-- ───────────────────────── social: parties ─────────────────────────

CREATE TABLE social.parties (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    leader_id  uuid NOT NULL REFERENCES auth.users(id),
    status     varchar(9) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disbanded')),
    -- Bumped on every membership/leader change. Matchmaking stores the version it queued
    -- with and re-validates it before forming a match (optimistic cross-DB consistency).
    version    integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social.party_members (
    party_id  uuid NOT NULL REFERENCES social.parties(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (party_id, user_id),
    UNIQUE (user_id)                         -- a user belongs to at most one party
);

-- Defense in depth for MAX_PARTY = 4. The service also locks the party row
-- (SELECT ... FOR UPDATE) so concurrent joins serialize before this count runs.
CREATE FUNCTION social.enforce_party_capacity() RETURNS trigger AS $$
BEGIN
    IF (SELECT count(*) FROM social.party_members WHERE party_id = NEW.party_id) >= 4 THEN
        RAISE EXCEPTION 'party % is full', NEW.party_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER party_capacity BEFORE INSERT ON social.party_members
    FOR EACH ROW EXECUTE FUNCTION social.enforce_party_capacity();

CREATE TABLE social.party_invitations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id   uuid NOT NULL REFERENCES social.parties(id) ON DELETE CASCADE,
    from_user  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    to_user    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status     varchar(9) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (from_user <> to_user)
);
CREATE UNIQUE INDEX party_invitations_one_pending ON social.party_invitations (party_id, to_user) WHERE status = 'pending';
CREATE INDEX party_invitations_to ON social.party_invitations (to_user) WHERE status = 'pending';
