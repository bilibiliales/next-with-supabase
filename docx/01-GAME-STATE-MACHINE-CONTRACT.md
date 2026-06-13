# 📄 01-GAME-STATE-MACHINE-CONTRACT.md

# Wolf AI — Game State Machine Contract v1.0

---

# 0. 总则（强约束）

本系统的唯一权威来源：

```text
game_state
```

任何其他数据源均为：

```text
derived state (非真相源)
```

---

## ❗禁止原则（必须遵守）

### 禁止 1：客户端推导状态

```text
客户端不得根据 messages / actions / events 推断当前阶段
```

---

### 禁止 2：event 驱动状态

```text
game_events 仅用于复盘，不参与实时逻辑
```

---

### 禁止 3：多写入状态源

```text
禁止在多个表同时维护 phase / alive / role
```

唯一允许写状态的是：

```text
game_state + game_member_state
```

---

# 1. 状态机定义

## 1.1 全局状态流

```text
WAITING
  ↓
NIGHT
  ↓
DAY
  ↓
VOTE
  ↓
SETTLEMENT
  ↓
(循环 NIGHT / DAY / VOTE)
  ↓
ENDED
```

---

## 1.2 状态说明

### WAITING

```text
- 房间未锁定
- 可加入/退出
- 可准备
```

---

### NIGHT

```text
- 狼人行动
- 女巫行动
- 预言家行动
```

---

### DAY

```text
- 公共讨论
- AI可发言
- 所有人可发言
```

---

### VOTE

```text
- 全员投票
- 不可发言（或限制发言）
```

---

### SETTLEMENT

```text
- 结算夜晚/投票结果
- 更新 alive 状态
- 推进 round_no
```

---

### ENDED

```text
- 游戏结束
- 写 game_results
- 解锁复盘模式
```

---

# 2. 状态推进规则（核心）

---

## 2.1 唯一推进入口

```text
所有状态推进只能通过 Edge Function：
next_phase()
```

---

## 2.2 禁止行为

```text
禁止：
- client update game_state
- cron 直接改 phase
- AI 触发 phase change
```

---

## 2.3 推进条件

### NIGHT → DAY

```text
满足条件：
- 所有 night actions resolved
- 或 deadline_at 超时
```

---

### DAY → VOTE

```text
满足条件：
- 发言阶段结束
- 或 timeout
```

---

### VOTE → SETTLEMENT

```text
满足条件：
- 所有 alive 玩家完成投票
- 或 timeout
```

---

### SETTLEMENT → NIGHT / END

```text
满足条件：
- 执行死亡结算
- 判断胜负
```

---

# 3. 并发控制模型（非常重要）

---

## 3.1 全局锁机制

所有 state mutation 必须使用：

```sql
pg_advisory_lock(game_id_hash)
```

---

## 3.2 锁范围

必须覆盖：

```text
- next_phase
- process_vote
- ai_turn
- start_game
```

---

## 3.3 锁原则

```text
同一 game_id 同一时间只允许一个 Edge Function 写状态
```

---

## 3.4 房间活跃游戏唯一性

```sql
create unique index one_active_game_per_room
on games(room_id)
where ended_at is null;
```

同一房间同一时间只能存在一个未结束的 game。

---

# 4. 状态版本控制（防重复推进）

---

## 4.1 game_state 定义

```sql
state_version int
```

---

## 4.2 写入规则

```text
UPDATE game_state
SET phase = ?,
    state_version = state_version + 1
WHERE game_id = ?
  AND state_version = ?
```

---

## 4.3 目的

防止：

```text
- 双 next_phase
- 重复 settlement
- AI 与 vote 并发冲突
```

---

# 5. Action 语义模型

---

## 5.1 action 生命周期

```text
created → locked → resolved
```

---

## 5.2 action 约束

```text
唯一性：
(game_id, actor_member_id, action_type, phase, round_no)
同一 action_type 可覆盖 target；不同 action_type 可并存。
```

---

## 5.3 action 规则

### NIGHT actions

```text
- wolf_kill → 只允许 1 target（最终聚合）
- seer_check → 单目标
- witch_heal → 单目标
- witch_poison → 单目标
```

---

### VOTE actions

```text
- 每人只能 vote 一次（可覆盖）
```

---

### TIMEOUT规则

```text
如果 deadline 超时：

- 未 action → 自动 pass
- 已 action → 锁定
```

---

# 6. AI 行为协议（强约束）

---

## 6.1 输入（Edge Function 提供）

AI 只能收到：

```text
- 当前 round summary
- 最近 N 条 messages
- 自己可见事件
- 自己 seat_no
```

---

## 6.2 严格禁止输入

```text
禁止提供：
- is_ai 信息
- 真实 user_id
- 全局 role list
- 狼人名单
```

---

## 6.3 输出格式（必须结构化）

```json
{
  "action": "speak | vote | skill | pass",
  "target": 3,
  "content": "..."
}
```

---

## 6.4 AI行为规则

```text
- AI 不保证每轮发言
- AI 可沉默
- AI 可主动带节奏
- AI 不得每次 prompt 都回应
```

---

## 6.5 AI人格系统

```text
personality ∈ {
  aggressive,
  logical,
  chaotic,
  deceptive,
  silent
}
```

影响：

```text
- 发言频率
- 投票倾向
- 目标选择
```

---

# 7. Seat Mapping Contract（关键）

---

## 7.1 绑定规则

```text
game_members.seat_no 是唯一真实身份载体
```

```text
game_member_profiles 保存初始化态（role / AI persona）
game_member_state 保存运行态（alive / death_reason / death_round / killed_by_member_id）
```

---

## 7.2 显示规则

客户端永远只看到：

```text
1号、2号、3号...
```

---

## 7.3 映射规则

```text
game_id + user_id → seat_no
```

---

## 7.4 AI规则

```text
AI：
user_id = NULL
is_ai = true
seat_no = valid
```

---

# 8. 胜负判定规则

---

## 8.1 胜利条件

### 狼人胜利

```text
wolves >= villagers
```

---

### 平民胜利

```text
wolves = 0
```

---

### draw

```text
特殊规则或异常终局
```

---

## 8.2 判定时机

```text
仅在 SETTLEMENT phase 执行
```

---

## 8.3 game_results 快照

每个座位必须写入可独立复盘的 `snapshot`：

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

允许追加 `alive`、`killed_by_member_id` 等字段，但不得缺少上述核心字段。

---

# 9. Realtime 约束

---

## 9.1 topic 规范

必须统一：

```text
room:{room_id}:{channel}
```

---

## 9.2 channel类型

```text
lobby
public
wolf
dead
system
```

---

## 9.3 channel 唯一性

```text
room-level:
unique(room_id, name) where game_id is null

game-level:
unique(game_id, name) where game_id is not null
```

`lobby` 使用 `game_id = null`；`system` 可用于房间级或游戏级；运行中游戏的 `public / wolf / dead / system` 使用当前 `game_id`。

---

## 9.4 权限原则

```text
Realtime 只负责消息，不负责状态
```

---

# 10. 一致性原则（最重要）

---

## 10.1 真相源优先级

```text
game_state > game_member_state > game_members > actions > events
```

---

## 10.2 禁止反推状态

```text
messages / events 不能反推 phase
```

---

## 10.3 Edge Function 责任

Edge Function 必须保证：

```text
- 状态唯一
- 行为幂等
- 并发安全
```

---

# 11. 幂等性规则

---

## 11.1 所有接口必须支持：

```text
request_id UUID
```

---

## 11.2 规则

```text
同 request_id 只能执行一次
```

```text
game_actions.request_id 是唯一 request identity；不得再创建 game_action_requests 账本表。
```

---

# 12. 失败恢复（Recover Model）

---

## 12.1 reconnect

恢复规则：

```text
- 读取 game_state
- 读取 game_members
- 读取 game_member_profiles
- 读取 game_member_state
- 重新订阅 channel
```

---

## 12.2 不允许：

```text
重新初始化 game
```

---

# 13. 关键安全规则（强约束）

---

## 13.1 客户端禁止访问

```text
- role of others
- is_ai
- wolf list
- hidden state
```

---

## 13.2 所有敏感信息必须：

```text
Edge Function 过滤后返回
```

---

# 14. 最终总结

```text
This system is not CRUD-based.
It is a deterministic state machine executed by Edge Functions with strict concurrency control and no client-side authority.
```
