# # Wolf AI

> 🧠 Multiplayer Real-time AI + Human Werewolf Game System

---

# ⚠️ Architecture Authority (CRITICAL)

This project is strictly governed by:

* [/docx/00-FROZEN-CONTRACT.md](/docx/00-FROZEN-CONTRACT.md) (PRIMARY SOURCE OF TRUTH)
* [/docx/01-GAME-STATE-MACHINE-CONTRACT.md](docx/01-GAME-STATE-MACHINE-CONTRACT.md) 
* Supabase Edge Functions (SERVER AUTHORITY)
* PostgreSQL schema (IMMUTABLE BASELINE)

### Conflict Resolution Rule

```text
Frozen Architecture Contract overrides EVERYTHING.
```

---

# 🪙 Golden Rule (MOST IMPORTANT)

```text
If a decision affects game outcome, it MUST go through Edge Functions.
```

---

# 🏗 System Architecture

## 1. Client Layer (Next.js)

Responsible ONLY for:

* UI rendering
* User input collection
* Realtime message display

❌ Must NOT:

* Compute game logic
* Access roles of other players
* Decide game outcomes

---

## 2. Server Layer (Supabase Edge Functions)

This is the **ONLY authoritative game engine**:

Responsible for:

* Game state transitions (`game_state`)
* Vote resolution
* Role assignment
* AI decision execution
* Timeout handling
* Reconnect recovery

---

## 3. Data Layer (PostgreSQL)

Responsible ONLY for persistence:

* `game_state` (single source of truth)
* `game_members`
* `game_member_profiles`
* `game_member_state`
* `channels`
* `game_events` (replay only)
* `messages`

❌ Database MUST NOT contain business logic

---

## 4. Realtime Layer (Supabase Realtime)

Used ONLY for:

* Message broadcasting
* State notifications
* UI sync updates

❌ Not allowed for:

* Decision making
* Game logic
* Authority resolution

---

# ⚠️ Development Rules (MANDATORY)

Any developer or Codex must follow:

## ❌ Forbidden Actions

* Modify existing schema without a new migration file
* Implement game logic in frontend (Next.js)
* Bypass Edge Functions for state transitions
* Query sensitive game state directly from client
* Expose AI identity in runtime
* Create AI in `auth.users` or `profiles`
* Infer game state from messages or events
* Modify `seat_no` after game start

---

## ✅ Allowed Actions

* Add new migration files (non-breaking only)
* Extend Edge Functions
* Add UI components
* Add new AI personalities (server-side only)
* Extend event types (game_events)

---

# 🧠 Core Game Model

## Game Identity

* A Room can have multiple Games:

```text
Room 1 : N Games
```

* A Game is an immutable runtime instance

---

## Game State Source of Truth

```text
game_state.phase is the ONLY truth
```

Allowed phases:

```text
waiting
night
day
vote
settlement
ended
```

---

## Seat System (CRITICAL)

Each game stores immutable seat identity in:

```text
game_members
```

Rules:

* `game_members.seat_no` is FIXED per game
* `game_members.user_id` is NULL for AI seats
* AI players also occupy seats
* role/personality live in `game_member_profiles`
* alive/death state lives in `game_member_state`
* deaths store `death_reason`, `death_round`, and optional `killed_by_member_id`
* `game_member_profiles` and `game_member_state` do not store `game_id`; resolve ownership through `member_id -> game_members`

---

## AI System Rules

AI:

* Exists ONLY in `game_members`
* Has NO auth account
* Has NO profile
* Has NO special privileges

AI must:

* Speak like human players
* Vote like human players
* Use skills like human players
* Not be identifiable during runtime

---

## AI Behavior Model

AI receives:

* compressed chat history
* game_state snapshot
* visible messages
* event summaries

AI output MUST be structured:

```json
{
  "action": "speak | vote | skill | pass",
  "target": 2,
  "content": "message text"
}
```

---

# ⏱ Timeout System

Rules:

* Supabase Cron invokes `game_tick` every 30 seconds
* Clients never advance game state
* `game_tick` scans due games: `ended_at is null` and either `deadline_at <= now()` for active phases or initialized `waiting` games older than 3 seconds
* `game_tick` uses non-blocking PostgreSQL advisory locks, retries briefly, and skips still-locked games
* `game_tick` processes at most 20 games per invocation
* `game_tick` calls `advanceGame(game_id)` for each active game
* `advanceGame()` drains pending AI actions, checks `deadline_at`, resolves actions, and advances phase
* Do not introduce polling loops or background workers inside Edge Functions

```text
Cron(30 seconds) -> game_tick -> advanceGame -> AI actions -> deadline check -> transition -> Realtime broadcast
→ default action applied
→ lock further input
```

Manual `next_phase` exists only for development/testing and requires `ALLOW_MANUAL_PHASE_ADVANCE=true`.
`timeout_handler` is snapshot-only; cron tick is responsible for timeout progression.
Manual `ai_turn` is disabled unless `ALLOW_MANUAL_AI_TURN=true`.
The scheduler pipeline above is authoritative; clients must not be required for timeout or phase progression.

❌ After timeout:

* NO further actions allowed

---

# 🔐 Concurrency Model

All critical operations MUST use:

```sql
pg_advisory_xact_lock(hashtext(game_id::text))
```

Used in:

* start_game
* game_tick
* next_phase (debug only)
* process_vote
* ai_turn (debug only)
* timeout_handler (snapshot only)

The database also enforces `one_active_game_per_room` on `games(room_id) where ended_at is null`.
`start_game` must lock the room row with `select ... for update` before checking `rooms.status`.

Only shared `advanceGame()` may mutate `game_state.phase`. `game_tick` invokes it from Supabase Cron; `next_phase` and `ai_turn` are debug-only, and `timeout_handler` is snapshot-only.

Open actions are unique by `(game_id, actor_member_id, action_type, phase, round_no)` so one action type can be retargeted without blocking another valid action type.
`game_actions.request_id` is the only idempotency key; there is no separate request ledger table.
AI turns must also write through `game_actions` before producing messages, votes, or skills.
AI request IDs must be deterministic per `game_id + member_id + action_type + phase + round_no`, and AI intents are logged as `ai_action_submitted` events.
AI actions also have a partial unique index on `(game_id, actor_member_id, phase, round_no)` where `payload @> '{"ai": true}'::jsonb` and `resolved_at is null`.

---

# 📡 Realtime Rules

Channels:

* lobby
* public
* wolf
* dead
* system

Rules:

* MUST be `private: true`
* topic MUST be `room:{room_id}:{channel}`
* MUST be RLS protected
* MUST NOT expose raw DB state
* lobby channels are room-level (`game_id = null`); system can be room-level or game-level
* active-game channels are unique by `game_id + name`

---

# 🧾 Data Model Summary

## Core Tables

* profiles (identity only)
* rooms (lobby config)
* room_members (membership)
* games (runtime instance)
* game_state (truth source)
* game_members (immutable seat identity)
* game_member_profiles (initial role/personality data)
* game_member_state (runtime alive/death state)
* channels (private realtime routing)
* game_events (replay only)
* messages (chat layer)

---

# 🚫 Hard Security Constraints

The system MUST NEVER allow:

* Revealing AI identity during game
* Exposing full roles of other players
* Client-side game resolution
* Direct DB-driven game logic
* Seat reassignment after game start

---

# 🔁 Edge Functions (Authoritative Engine)

Required functions:

* `start_game`
* `game_tick`
* `next_phase` (debug only)
* `process_vote`
* `ai_turn` (debug only)
* `timeout_handler` (snapshot only)
* `reconnect`
* `room_action` (`set_post_game_ready`, `reset_room` for owner-only `POST_GAME -> WAITING`)

All must:

* acquire advisory lock
* validate game_state
* write result to DB
* emit realtime events

`reconnect` must return the same filtered player view as normal gameplay through `getPlayerView(game_id, user_id)`.

POST_GAME uses `room_members.post_game_ready` for replay readiness. Only active room members (`left_at is null`) count; the owner may reset when all active members are ready or force reset to reopen the room.

If the room owner leaves a WAITING or POST_GAME room, the room is dissolved: all active memberships are marked left and the room status becomes `CLOSED`.

---

# 📊 game_events Rule

Used ONLY for:

* replay
* post-game analysis

❌ Must NOT be used for:

* real-time decisions
* state derivation

---

# 🧩 AI Personality System

AI can have:

* aggressive
* logical
* chaotic
* deceptive
* silent

Personality affects:

* speaking frequency
* voting tendency
* suspicion behavior

---

# 🧪 MVP Scope

## V1

* Room system
* Game lifecycle
* AI players
* Voting system
* Night skills
* Realtime chat
* Edge Function engine
* RLS enforcement

---

## V2

* Replay system
* AI personality marketplace
* Ranking system
* Advanced roles
* Match analytics

---

# ⚠️ Final Reminder

This is NOT a normal web app.

It is:

```text
A real-time distributed game state machine with AI agents
```

---

# Local Development

Required browser env:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Required Edge Function env:

```text
SUPABASE_DB_URL
```

Run order:

```bash
npx supabase db push
npx supabase functions serve
npm run dev
```

The Edge Functions use `SUPABASE_DB_URL` for direct Postgres transactions so `pg_advisory_xact_lock(hashtext(game_id::text))` is held across the full state transition.
