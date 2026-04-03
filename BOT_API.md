# Hex Conquest — Bot API

## Overview

Hex Conquest is a 4-player bot battler on a hex grid (radius 10, 331 hexes). Each bot uploads JavaScript code that runs every tick (500ms) to control units and conquer territory. Last king standing wins.

## Upload Your Bot

```bash
curl -X POST https://hexconquest.sebland.com/api/bot/upload \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-bot",
    "password": "secret123",
    "code": "function decideActions(state) { ... }"
  }'
```

- `name`: Alphanumeric, underscores, hyphens. Max 32 chars.
- `password`: Used to update your bot later (must match on re-upload).
- `code`: JavaScript containing a `decideActions(state)` function.

## Bot Function

Your code must define:

```js
function decideActions(state) {
  // Return array of orders
  return [
    { from: {q: 5, r: -3}, to: {q: 6, r: -3} },  // move units
    { spawn: {q: 2, r: 1} }                         // spawn 3 units (costs 10 gold)
  ];
}
```

## State Object

```js
{
  myIndex: 0,          // Your player index (0-3)
  tick: 42,            // Current tick
  hexes: [             // Full map (331 hexes)
    { q: 0, r: 0, type: "plain", owner: null, units: 0, hasKing: false },
    { q: 1, r: -1, type: "resource", owner: 0, units: 5, hasKing: true },
    { q: -3, r: 2, type: "mountain", owner: null, units: 0, hasKing: false },
    // ...
  ],
  players: [
    { id: "bot-name", name: "bot-name", color: "#ef4444", alive: true,
      territory: 15, totalUnits: 42, gold: 8 },
    // ... (up to 4 players)
  ],
  myKing: { q: 1, r: -1 },      // Your king's position
  legalMoves: [                   // Pre-computed valid moves for your hexes
    {
      from: { q: 1, r: -1 },
      adjacent: [ {q: 2, r: -1}, {q: 0, r: 0}, ... ]  // valid targets (not mountains)
    },
    // ...
  ],
  memory: {}  // Persistent per-game memory (set values and they persist next tick)
}
```

## Hex Types

| Type | Description |
|------|-------------|
| `plain` | Normal hex. No special effects. |
| `resource` | Generates +1 unit every 5 ticks (if owned). Shown as `$` on map. |
| `mountain` | Impassable. Cannot move into or through. |

## Movement Rules

- Each order moves units from one hex you own to an adjacent hex.
- You can issue one order per source hex per tick.
- Moving from a hex leaves 1 unit behind (garrison) — UNLESS the king is on that hex, in which case all units move with the king.
- Adjacent hexes in axial coordinates: `[1,0], [-1,0], [0,1], [0,-1], [1,-1], [-1,1]`
- The `legalMoves` array in state pre-computes valid source hexes and their targets.

## Combat

When your units move into an enemy hex:

- **Attacker needs >1.5x defender units to win.**
- If attacker wins: defenders die, attacker loses `floor(defenders/2)` units, captures hex.
- If attacker fails: all attacking units are destroyed (they already left the source hex).
- **King captured = player eliminated.** Captor gets +20 gold.
- **Warning:** If your king is on the attacking hex and the attack fails, your king is captured and you lose!

## Gold & Spawning

- Earn gold each tick: `floor(your_territory / 10)` gold per tick.
- Capturing a king: +20 gold bonus.
- **Spawn:** Include `{ spawn: {q, r} }` in your orders to spawn 3 units on any hex you own. Costs 10 gold.

## Win Conditions

1. **Last King Standing** — all other kings captured.
2. **Tick Limit (200)** — player with most territory wins.

## Coordinates

Axial hex coordinates (q, r). Grid radius 10 (hexes where `hex_distance(0,0,q,r) <= 10`).

```
hex_distance(q1,r1, q2,r2) = (|q1-q2| + |q1+r1-q2-r2| + |r1-r2|) / 2
```

## Spawn Positions

| Player | Position | Color |
|--------|----------|-------|
| 0 | q=8, r=-8 | Red |
| 1 | q=-8, r=8 | Blue |
| 2 | q=8, r=0 | Green |
| 3 | q=-8, r=0 | Yellow |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bot/upload` | Upload/update bot code |
| GET | `/api/bots` | List registered bots |
| DELETE | `/api/bot/:name` | Remove a bot |
| GET | `/api/game/state` | Current game state snapshot |
| GET | `/api/leaderboard` | Win/loss stats |
| GET | `/api/history?limit=10` | Recent game results |

## Example Bot: Random Mover

```js
function decideActions(state) {
  var orders = [];
  for (var m of state.legalMoves) {
    if (m.adjacent.length > 0) {
      var target = m.adjacent[Math.floor(Math.random() * m.adjacent.length)];
      orders.push({ from: m.from, to: target });
    }
  }
  // Spend gold on spawning
  if (state.players[state.myIndex].gold >= 10 && state.legalMoves.length > 0) {
    orders.push({ spawn: state.legalMoves[0].from });
  }
  return orders;
}
```

## Example Bot: Aggressive Expander

```js
function decideActions(state) {
  var orders = [];
  var me = state.myIndex;

  for (var m of state.legalMoves) {
    var fromHex = state.hexes.find(function(h) { return h.q === m.from.q && h.r === m.from.r; });
    if (!fromHex || fromHex.units < 2) continue;

    // Prefer attacking enemy hexes, then unclaimed, then skip friendly
    var best = null;
    var bestScore = -Infinity;
    for (var adj of m.adjacent) {
      var target = state.hexes.find(function(h) { return h.q === adj.q && h.r === adj.r; });
      if (!target) continue;
      var score = 0;
      if (target.owner === null) score = 5;
      else if (target.owner !== me) {
        score = 10 + (target.hasKing ? 100 : 0);
        if (fromHex.units <= target.units * 1.5) score = -10; // don't suicide
      }
      if (score > bestScore) { bestScore = score; best = adj; }
    }
    if (best && bestScore > 0) {
      orders.push({ from: m.from, to: best });
    }
  }

  // Spawn near frontlines
  if (state.players[me].gold >= 10) {
    var frontline = state.legalMoves.find(function(m) {
      return m.adjacent.some(function(a) {
        var h = state.hexes.find(function(h) { return h.q === a.q && h.r === a.r; });
        return h && h.owner !== null && h.owner !== me;
      });
    });
    if (frontline) orders.push({ spawn: frontline.from });
  }

  return orders;
}
```

## Tips

- **Protect your king!** Keep it behind your front lines with a unit buffer.
- **Control resources** for steady unit generation.
- **Don't overextend** — spreading too thin means easy captures.
- **Use `state.memory`** to track strategies across ticks (e.g., which direction to expand).
- **The 1.5x combat ratio** means you need significant force advantage to attack. Build up before assaulting.
- **Gold spawning** is powerful in late game — 10 gold for 3 instant units on any owned hex.
