# Wolf AI 前端需求文档（MVP）

## 项目名称

Wolf AI

AI + 真人混合狼人杀平台

---

# 技术栈

固定：

* React
* Next.js App Router
* TypeScript
* Supabase JS
* TailwindCSS
* Zustand

禁止：

* Redux
* MobX
* Socket.io

Realtime：

* Supabase Realtime Private Channels

---

# 页面结构

## 1 首页

Route:

```text
/
```

功能：

* 登录状态检查
* reconnect

调用：

```ts
game_action({
  action: "reconnect"
})
```

返回：

### 情况1

无房间

进入大厅

### 情况2

WAITING房间

进入房间

### 情况3

进行中的游戏

进入游戏

### 情况4

POST_GAME

进入复盘页面

---

# 2 大厅

Route

```text
/lobby
```

功能：

* 房间列表

接口：

```ts
room_action({
  action: "list_rooms"
})
```

显示：

* 房间名
* 当前人数
* AI模式
* 最大人数

按钮：

```text
创建房间
加入房间
邀请码加入
```

---

# 3 创建房间

字段：

```ts
name
max_players
visibility
ai_mode
ai_count
```

接口：

```ts
create_room
```

---

# 4 房间页面

Route

```text
/room/[id]
```

数据：

```ts
room_snapshot
```

显示：

### 房间信息

```text
房间名称
邀请码
房主
人数
```

---

### 成员列表

显示：

```text
昵称
准备状态
房主标识
```

---

### 操作

房主：

```text
开始游戏
```

普通玩家：

```text
准备
取消准备
```

---

# 房间状态机

WAITING

↓

LOCKED

↓

POST_GAME

↓

WAITING

---

# 5 游戏页面

Route

```text
/game/[id]
```

数据：

```ts
game_snapshot
```

---

# 游戏UI

## 顶部

显示：

```text
当前阶段

night
day
vote
settlement
```

显示：

```text
第几轮
剩余时间
```

---

## 座位区

显示：

```text
1号
2号
3号
...
```

状态：

```text
存活
死亡
```

不能显示：

```text
角色
身份
AI
```

游戏中全部隐藏

---

## 聊天区

频道：

```text
public
wolf
dead
system
```

前端只显示：

```ts
snapshot.channels
```

允许访问的频道

---

# 发言

调用：

```ts
message_action
```

---

# 玩家视图

## 狼人

白天：

```text
public
system
```

夜晚：

```text
public
wolf
system
```

---

## 死亡玩家

```text
dead
system
```

---

## 普通玩家

```text
public
system
```

---

# 行动区

根据角色动态显示

---

## Seer

夜晚

```text
查验玩家
```

---

## Witch

夜晚

```text
救人
毒人
```

---

## Hunter

死亡触发

```text
开枪
```

---

## Villager

无技能

---

## Wolf

夜晚杀人

---

# 投票阶段

vote

显示：

```text
所有存活玩家
```

按钮：

```text
投票
```

调用：

```ts
action_action
```

---

# Realtime

进入房间：

订阅：

```text
room:{roomId}:lobby
room:{roomId}:system
```

---

进入游戏：

订阅：

```text
room:{roomId}:public
room:{roomId}:wolf
room:{roomId}:dead
room:{roomId}:system
```

只订阅：

```ts
snapshot.channels
```

允许的频道

---

# 复盘页面

POST_GAME

Route

```text
/game/[id]
```

因为：

```ts
snapshot.post_game !== null
```

自动进入复盘模式

---

显示

```text
全部身份
胜利阵营
死亡顺序
```

来自：

```ts
post_game
```

---

# 复盘准备

按钮：

```text
我已看完
```

调用：

```ts
set_post_game_ready
```

---

显示：

```ts
post_game_ready
```

内容：

```text
ready_count
active_count
```

例如：

3 / 5 已完成复盘

---

# 再来一局

仅房主显示

---

条件：

```ts
all_ready === true
```

显示：

```text
开始下一局
```

调用：

```ts
reset_room
```

---

# 强制开始下一局

房主

显示：

```text
强制开始
```

确认弹窗：

```text
仍有玩家未完成复盘
是否继续？
```

调用：

```ts
reset_room({
 force:true
})
```

---

# AI玩家展示规则

游戏中：

```text
不能显示AI
```

和真人完全一致

---

复盘时：

允许显示

```text
AI
AI名称
身份
```

因为：

```ts
post_game
```

已经包含：

```ts
is_ai
nickname
role
```

---

# 前端架构要求

目录：

```text
src/

app/
components/
features/

  auth/
  room/
  game/
  replay/

hooks/
services/
store/
types/
```

---

状态管理

Zustand

模块：

```text
authStore
roomStore
gameStore
realtimeStore
```