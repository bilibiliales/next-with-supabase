# 🧩 Wolf AI PRD v1.1（完整规范版）

---

# 1. 项目概述

## 项目名称

```text
Wolf AI
```

## 类型

```text
多人实时 + AI混合对抗狼人杀平台
```

---

## 核心目标

构建一个：

```text
真人 + AI 同场推理博弈系统
```

特点：

* AI不可识别（游戏中）
* AI具备完整策略能力
* 游戏强一致状态机
* Edge Function 作为唯一可信服务器
* Supabase Realtime 仅用于消息分发

---

# 2. 核心设计原则（最高优先级）

## 2.1 状态唯一性原则

```text
game_state = 唯一真相源
```

任何状态冲突：

```text
以 game_state 为准
```

---

## 2.2 服务端权威原则

禁止：

```text
前端决定任何游戏结果
```

所有逻辑：

```text
Edge Functions 执行
```

---

## 2.3 AI不可特权原则

AI：

```text
与真人完全同权
```

禁止：

* AI专属接口
* AI额外信息源
* AI绕过RLS

---

## 2.4 信息隔离原则

客户端只能看到：

```text
seat_no
role（仅自己）
alive状态（有限）
channel消息
```

---

# 3. 用户与座位系统（关键）

## 3.1 game_members（核心座位模型）

```sql
create table game_members (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null,
    user_id uuid,
    seat_no int,
    is_ai boolean
);

create table game_member_profiles (
    member_id uuid,
    role text,
    ai_personality text,
    ai_name text check (char_length(ai_name) <= 50)
);

create table game_member_state (
    member_id uuid,
    alive boolean default true,
    death_reason text,
    death_round int,
    killed_by_member_id uuid
);
```

---

## 规则：

```text
一局游戏中 user_id → seat_no 固定
```

---

## AI：

```text
user_id = NULL
seat_no = assigned
is_ai = true
```

---

## 复盘映射：

```text
game_members.seat_no → user_id → profile.nickname
```

---

# 4. 房间系统（Room）

## 4.1 rooms

```text
WAITING → LOCKED → POST_GAME → WAITING → CLOSED
```

---

## LOCKED状态（关键）

```text
禁止：
- 加入
- 退出
- 修改设置
```

允许：

* reconnect
* game chat
* voting

---

## AI补位规则

```text
start_game 时动态填充 AI
```

---

# 5. 游戏系统（Game）

## 5.1 games

```text
Room 1:N Game
```

---

## 5.2 game_state（唯一状态源）

```sql
phase:
waiting
night
day
vote
settlement
ended
```

---

## 强约束：

```text
所有 transition 只能由 Edge Function 修改
```

---

## 5.3 状态推进

统一流程：

```text
next_phase()
```

触发：

* 投票结束
* 夜晚结束
* 超时
* AI决策完成

---

# 6. 并发控制（Advisory Lock）

## 所有关键函数必须：

```sql
pg_advisory_xact_lock(game_id_hash)
```

覆盖：

* start_game
* process_vote
* ai_turn
* next_phase
* timeout handler

---

## 原则：

```text
同一时间只允许一个状态推进
```

---

# 7. 游戏成员系统

## 7.1 game_members

```sql
seat_no 固定
role 固定
alive 状态变化
```

---

## AI规则：

```text
is_ai = true
user_id = NULL
```

---

## 禁止：

```text
AI进入auth.users
```

---

# 8. 身份系统

角色：

```text
狼人
平民
预言家
女巫
猎人
```

---

## 扩展：

```text
情侣
守卫
白狼王
```

---

## 重要：

```text
允许重复角色（同局多狼人等）
```

---

# 9. AI系统（核心创新）

## 9.1 AI行为原则

AI可以：

* 发言
* 投票
* 使用技能
* 带节奏
* 推理

---

## AI禁止：

* 每轮必答
* 轮询机制
* 特权信息

---

## 9.2 AI人格系统

```text
aggressive
logical
chaotic
bluffer
silent killer
```

---

## 9.3 AI上下文输入

每轮输入：

```text
compressed history
+ current phase
+ visible messages
+ events summary
```

---

## 输出必须结构化：

```json
{
  "action": "speak | vote | skill | pass",
  "target": 2,
  "content": "xxx"
}
```

---

## AI不能识别：

```text
自己是AI（游戏内）
```

---

# 10. Realtime系统

## 必须：

```js
private: true
```

---

## channels：

* lobby
* public
* wolf
* dead
* system

---

channel 规则：

```text
lobby: game_id = null
system: room-level or game-level
game channels: unique(game_id, name)
```

---

## 规则：

```text
频道访问 = RLS + Edge Function过滤
```

---

# 11. 消息系统

```sql
messages
```

---

AI消息：

```json
sender_id = null
metadata:
{
  seat: 5
}
```

---

# 12. 断线重连

## reconnect逻辑：

```text
检查：
room_members
game_members
game_state
```

---

恢复：

* seat
* role
* alive
* channel subscription

---

# 13. 投票与夜间系统

## 13.1 投票

```text
process_vote()
```

规则：

* 超时自动弃票
* 只执行一次
* lock保护

---

## 13.2 夜间技能

```text
wolf_kill
seer_check
witch_heal
witch_poison
```

---

## 执行顺序：

```text
lock → collect → resolve → next_phase
```

---

# 14. 超时机制（重要）

## 规则：

```text
超时 → 3秒缓冲 → 默认行为 → 锁定结果
```

---

## 默认行为：

* 投票：弃票
* 夜晚：不行动
* 发言：跳过

---

## 禁止：

```text
超时后仍允许操作
```

---

# 15. RLS规则（强约束）

## 原则：

```text
客户端不能直接查询敏感表
```

---

## 所有查询必须：

```text
Edge Function service role
```

---

## RLS职责：

* 阻止非法访问
* 不参与逻辑判断

---

# 16. 战绩系统

仅保存：

```text
winner
role
duration
timestamp
```

---

禁止：

```text
完整聊天记录
完整回放
```

---

# 17. AI与真人不可区分性

游戏内：

```text
禁止标识AI
禁止提示AI身份
```

---

赛后：

```text
允许展示：
- 是否AI
- 对应user_id
- seat映射
```

---

# 18. MVP范围

## V1：

* Room系统
* Game状态机
* AI补位
* Realtime聊天
* 投票
* 夜间技能
* RLS
* Edge Function

---

## V2：

* AI人格市场
* 排行榜
* 观战（禁止项已确认未来可选）
* 回放系统
* 反作弊分析

---
