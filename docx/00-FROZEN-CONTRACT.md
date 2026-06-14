# 🧱 Wolf AI SQL Baseline Contract v1.0

---

# 0. 绝对冻结原则（IMPORTANT）

```text
任何表结构变更必须：
1. 新建 migration 文件
2. 不允许修改已定义字段语义
3. 不允许删除字段（只能 deprecated）
4. 不允许绕过 Edge Function 直接操作游戏逻辑
```

---

# 1. 核心设计不变量（Schema Invariants）

## 1.1 Game 是唯一运行单元

```text
games = runtime container
```

```text
CreateGameMembers Transaction Rule:
Insert game_members, game_member_profiles, and game_member_state in one transaction.
Partial initialization is forbidden.
```

不允许：

* room 直接存 role
* room 直接存 game state

---

## 1.2 game_state 是唯一状态源

```sql
game_state.phase 是唯一真相
```

```text
Only shared advanceGame() may mutate game_state.phase.
game_tick invokes advanceGame() from Supabase Cron every 30 seconds.
advanceGame() owns AI action draining, deadline checks, action resolution, and phase transition.
game_tick must only scan due games: ended_at is null and (deadline_at <= now() or phase = 'waiting').
game_tick must use a non-blocking PostgreSQL advisory transaction lock and skip locked games.
next_phase is debug-only and requires ALLOW_MANUAL_PHASE_ADVANCE=true.
timeout_handler is snapshot-only and must not call advanceGame().
ai_turn is debug-only and requires ALLOW_MANUAL_AI_TURN=true.
process_vote / process_skill / ai_turn must not advance phase.
```

禁止：

* 前端推断状态
* messages 推断状态
* event 推断状态

---

## 1.3 seat 永久绑定（不可变）

```text
game_members.seat_no 一旦生成，不允许修改
```

---

## 1.4 AI = runtime entity（非用户）

```text
AI 不存在于 auth.users
AI 不存在 profiles
AI 只存在 game_members
```

---

# 2. 标准SQL基线（冻结版）

## 2.1 profiles（不可扩展核心字段）

```sql
create table profiles (
    id uuid primary key references auth.users(id),
    nickname text not null,
    avatar_url text,
    created_at timestamptz default now()
);
```

---

## 2.2 rooms（仅配置层）

```sql
create table rooms (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid references profiles(id),
    name text,
    visibility text,
    invite_code text unique,
    password_hash text,
    max_players int,
    ai_count int default 0,
    ai_mode text,
    status text,
    created_at timestamptz default now()
);
```

---

## 2.3 room_members（唯一房间约束）

```sql
create table room_members (
    room_id uuid,
    user_id uuid,
    is_ready boolean default false,
    joined_at timestamptz default now(),
    left_at timestamptz,
    primary key(room_id, user_id)
);
```

---

## UNIQUE constraint（必须保留）

```sql
create unique index one_room_per_user
on room_members(user_id)
where left_at is null;
```

---

## 2.4 games（运行容器）

```sql
create table games (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references rooms(id),
    started_at timestamptz,
    ended_at timestamptz,
    winner text
);

create unique index one_active_game_per_room
on games(room_id)
where ended_at is null;
```

```sql
-- start_game must lock the room row before checking status
select *
from rooms
where id = ?
for update;
```

---

## 2.5 channels（Realtime频道）

```sql
create table channels (
    id uuid primary key default gen_random_uuid(),
    room_id uuid references rooms(id),
    game_id uuid references games(id),
    name text,
    is_private boolean default true,
    check (
        (game_id is null and name in ('lobby', 'system'))
        or (game_id is not null and name in ('public', 'wolf', 'dead', 'system'))
    )
);

create unique index one_room_level_channel_name
on channels(room_id, name)
where game_id is null;

create unique index one_game_channel_name
on channels(game_id, name)
where game_id is not null;
```

---

## 2.6 game_members（不可变座位身份）

```sql
create table game_members (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null references games(id),
    seat_no int,
    user_id uuid,
    is_ai boolean default false
);

create index game_members_game_idx
on game_members(game_id);
```

---

## 2.7 game_member_profiles（初始化态）

```sql
create table game_member_profiles (
    member_id uuid primary key references game_members(id),
    role text,
    ai_personality text,
    ai_name text check (ai_name is null or char_length(ai_name) <= 50)
);
```

```text
ai_personality is SERVER ONLY and must never be sent to client or messages.
```

---

## 2.8 game_member_state（运行态）

```sql
create table game_member_state (
    member_id uuid primary key references game_members(id),
    alive boolean default true,
    death_reason text,
    death_round int,
    killed_by_member_id uuid references game_members(id),
    updated_at timestamptz default now(),
    check (
        (alive = true and death_reason is null and death_round is null and killed_by_member_id is null)
        or (alive = false and death_reason is not null and death_round is not null)
    )
);
```

---

## 2.9 game_state（唯一状态源）

```sql
create table game_state (
    game_id uuid primary key references games(id),
    phase text,
    round_no int default 1,
    deadline_at timestamptz,
    state_version int default 0,
    updated_at timestamptz default now()
);
```

---

## 2.10 game_events（不可用于状态判断）

```sql
create table game_events (
    id bigserial primary key,
    game_id uuid,
    actor_member_id uuid,
    event_type text check (event_type in (
        'game_started',
        'vote_resolved',
        'night_resolved',
        'phase_changed',
        'game_ended',
        'ai_action_submitted'
    )),
    payload jsonb,
    created_at timestamptz default now()
);
```

---

## 2.10a game_actions.request_id（幂等请求）

```text
Do not create game_action_requests.
Use game_actions.request_id as the only request identity.
```

---

## ⚠️ 关键限制：

```text
game_events 只能用于回放，不得用于实时决策
```

---

## 2.11 messages（Realtime唯一载体）

```sql
create table messages (
    id bigserial primary key,
    room_id uuid,
    game_id uuid,
    channel_id uuid references channels(id),
    sender_id uuid,
    content text,
    created_at timestamptz default now()
);
```

---

## 2.12 game_results（复盘快照）

```sql
create table game_results (
    id bigserial primary key,
    game_id uuid,
    member_id uuid,
    seat_no int not null,
    is_ai boolean not null,
    role text,
    winner text,
    snapshot jsonb not null,
    duration_seconds int,
    created_at timestamptz default now()
);
```

```json
{
  "seat": 1,
  "display_name": "Bob",
  "user_id": "00000000-0000-0000-0000-000000000000",
  "is_ai": false,
  "role": "wolf",
  "death_reason": "vote_out",
  "death_round": 3
}
```

---

# 3. Edge Function 强约束（最重要）

## 3.1 允许的唯一写入口

```text
ALL writes to game logic must go through Edge Functions
```

---

## 必须存在函数：

```text
start_game
game_tick
next_phase (debug only)
process_vote
ai_turn (debug only)
timeout_handler (snapshot only)
reconnect
room_action.reset_room
```

---

## ❌ 禁止：

* client update game_state
* client update game_member_profiles.role
* client update game_member_state.alive
* client insert game_events directly for logic

---

# 4. Advisory Lock（强一致机制）

```sql
pg_advisory_xact_lock(hashtext(game_id::text))
```

必须用于：

* start_game
* game_tick
* next_phase (debug only)
* vote resolution
* AI actions
* timeout handler (snapshot only)

---

# 5. RLS（最严格版本）

## 规则：默认全部拒绝

```sql
ALTER TABLE game_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_member_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_member_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
```

---

## RLS原则：

```text
所有 SELECT 都必须通过 Edge Function
```

---

## 推荐策略（核心）

```sql
USING (false)
```

然后：

* Edge Function 用 service role bypass

---

# 6. Realtime约束

```text
private channels ONLY
topic = room:{room_id}:{channel}
```

---

## channel规则：

* lobby → waiting
* public → day
* wolf → night
* dead → dead
* system → global events

---

# 7. AI系统约束（关键）

## AI限制：

```text
AI cannot access DB directly
AI only receives:
- compressed state
- visible messages
- event summary
AI actions must be persisted through game_actions before messages/votes/skills are produced.
```

---

## AI输出必须：

```json
{
  "action": "speak | vote | skill | pass",
  "target": number,
  "content": string
}
```

---

# 8. 超时机制（固定规则）

```text
T + 3s grace period → default action → lock state
```

---

## 超时后：

```text
no further action allowed
```

---

# 9. 绝对禁止行为列表（非常重要）

Codex 不允许：

* AI进入 auth.users
* 客户端查询 roles
* 客户端推断 game_state
* 修改 seat_no
* 动态重排 seat
* 用 messages 推断身份
* 用 game_events 做实时逻辑

---

# 10. 你现在这个系统的真实结构（总结）

你可以把整个系统理解成：

```text
Supabase = 数据层
Edge Function = 游戏服务器
Realtime = 广播层
AI = 非确定性玩家
Postgres = 状态机存储
```
