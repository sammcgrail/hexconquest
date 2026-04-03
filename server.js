var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var Database = require("better-sqlite3");

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ noServer: true });

var PORT = 8080;
var HEX_RADIUS = 10;
var MAX_TICKS = 200;
var TICK_MS = 500;
var BOT_TIMEOUT_MS = 2000;
var RESOURCE_INTERVAL = 5;
var COMBAT_RATIO = 1.5;
var DB_PATH = path.join(__dirname, "data", "hexconquest.db");
var BOTS_DIR = path.join(__dirname, "data", "bots");

var PLAYER_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
var PLAYER_NAMES = ["Red", "Blue", "Green", "Yellow"];
var SPAWN_POSITIONS = [
  { q: 8, r: -8 },   // Player 0: top-right
  { q: -8, r: 8 },   // Player 1: bottom-left
  { q: 8, r: 0 },    // Player 2: right
  { q: -8, r: 0 }    // Player 3: left
];
var ADJACENT_DIRS = [
  { q: 1, r: 0 }, { q: -1, r: 0 },
  { q: 0, r: 1 }, { q: 0, r: -1 },
  { q: 1, r: -1 }, { q: -1, r: 1 }
];

// Ensure data directories exist
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// SQLite setup
var db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    players TEXT NOT NULL,
    winner TEXT,
    reason TEXT,
    ticks INTEGER
  )
`);

// ============ HEX MATH ============

function hexKey(q, r) { return q + "," + r; }

function hexDistance(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

function isValidHex(q, r) {
  return hexDistance(0, 0, q, r) <= HEX_RADIUS;
}

function getAdjacent(q, r) {
  var adj = [];
  for (var d of ADJACENT_DIRS) {
    var nq = q + d.q, nr = r + d.r;
    if (isValidHex(nq, nr)) adj.push({ q: nq, r: nr });
  }
  return adj;
}

// ============ MAP GENERATION ============

function generateMap() {
  var hexes = new Map();

  // Create all hexes in radius
  for (var q = -HEX_RADIUS; q <= HEX_RADIUS; q++) {
    for (var r = -HEX_RADIUS; r <= HEX_RADIUS; r++) {
      if (!isValidHex(q, r)) continue;
      hexes.set(hexKey(q, r), {
        q: q, r: r, type: "plain", owner: null, units: 0, hasKing: false
      });
    }
  }

  // Place mountains (~15, not on spawns)
  var spawnKeys = new Set(SPAWN_POSITIONS.map(function(s) { return hexKey(s.q, s.r); }));
  var spawnNeighborKeys = new Set();
  for (var sp of SPAWN_POSITIONS) {
    spawnNeighborKeys.add(hexKey(sp.q, sp.r));
    for (var adj of getAdjacent(sp.q, sp.r)) {
      spawnNeighborKeys.add(hexKey(adj.q, adj.r));
    }
  }

  var allKeys = Array.from(hexes.keys());
  var mountainCount = 0;
  var shuffled = allKeys.slice().sort(function() { return Math.random() - 0.5; });
  for (var key of shuffled) {
    if (mountainCount >= 15) break;
    if (spawnNeighborKeys.has(key)) continue;
    var hex = hexes.get(key);
    // Don't place mountains at center either
    if (hex.q === 0 && hex.r === 0) continue;
    hex.type = "mountain";
    mountainCount++;
  }

  // Place resource hexes (~8, not on spawns, mountains)
  var resourceCount = 0;
  shuffled = allKeys.slice().sort(function() { return Math.random() - 0.5; });
  for (var key of shuffled) {
    if (resourceCount >= 8) break;
    var hex = hexes.get(key);
    if (hex.type !== "plain") continue;
    if (spawnNeighborKeys.has(key)) continue;
    // Place resources in middle band (distance 3-8 from center)
    var dist = hexDistance(0, 0, hex.q, hex.r);
    if (dist < 3 || dist > 8) continue;
    hex.type = "resource";
    resourceCount++;
  }

  return hexes;
}

// ============ GAME STATE ============

var game = null;
var gameTimer = null;
var botMemories = {};  // per-game bot memory

function createGame() {
  var bots = loadBots();
  if (bots.length < 2) {
    console.log("Need at least 2 bots to start a game. Have " + bots.length);
    return null;
  }

  // Take up to 4 bots
  var activeBots = bots.slice(0, 4);
  var hexes = generateMap();

  var players = [];
  for (var i = 0; i < activeBots.length; i++) {
    var spawn = SPAWN_POSITIONS[i];
    var spawnHex = hexes.get(hexKey(spawn.q, spawn.r));
    spawnHex.owner = i;
    spawnHex.units = 5;
    spawnHex.hasKing = true;

    // Give starting territory: the spawn hex + adjacent hexes
    for (var adj of getAdjacent(spawn.q, spawn.r)) {
      var adjHex = hexes.get(hexKey(adj.q, adj.r));
      if (adjHex && adjHex.type !== "mountain") {
        adjHex.owner = i;
        adjHex.units = 2;
      }
    }

    players.push({
      id: activeBots[i].name,
      name: activeBots[i].name,
      color: PLAYER_COLORS[i],
      alive: true,
      gold: 0,
      kingPos: { q: spawn.q, r: spawn.r },
      code: activeBots[i].code
    });
  }

  botMemories = {};
  for (var i = 0; i < players.length; i++) {
    botMemories[i] = {};
  }

  return {
    id: crypto.randomUUID(),
    tick: 0,
    phase: "playing",
    hexes: hexes,
    players: players,
    combatLog: [],
    maxTicks: MAX_TICKS
  };
}

// ============ BOT MANAGEMENT ============

function loadBots() {
  if (!fs.existsSync(BOTS_DIR)) return [];
  var files = fs.readdirSync(BOTS_DIR).filter(function(f) { return f.endsWith(".json"); });
  var bots = [];
  for (var f of files) {
    try {
      var data = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, f), "utf-8"));
      bots.push(data);
    } catch (e) {
      console.error("Failed to load bot " + f + ": " + e.message);
    }
  }
  return bots;
}

function saveBot(name, password, code) {
  var filePath = path.join(BOTS_DIR, name + ".json");
  // Check if exists and password matches
  if (fs.existsSync(filePath)) {
    var existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (existing.password !== password) {
      return { error: "Wrong password for existing bot" };
    }
  }
  var bot = { name: name, password: password, code: code, updated: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(bot, null, 2));
  return { ok: true };
}

function deleteBot(name) {
  var filePath = path.join(BOTS_DIR, name + ".json");
  if (!fs.existsSync(filePath)) return { error: "Bot not found" };
  fs.unlinkSync(filePath);
  return { ok: true };
}

// ============ BOT EXECUTION ============

function buildBotState(playerIndex) {
  var player = game.players[playerIndex];
  var hexArray = [];
  var legalMoves = [];

  for (var [key, hex] of game.hexes) {
    hexArray.push({
      q: hex.q, r: hex.r, type: hex.type,
      owner: hex.owner, units: hex.units, hasKing: hex.hasKing
    });

    // Build legal moves for this player's hexes
    if (hex.owner === playerIndex && hex.units > 0) {
      var adjacent = getAdjacent(hex.q, hex.r).filter(function(a) {
        var target = game.hexes.get(hexKey(a.q, a.r));
        return target && target.type !== "mountain";
      });
      if (adjacent.length > 0) {
        legalMoves.push({ from: { q: hex.q, r: hex.r }, adjacent: adjacent });
      }
    }
  }

  var playerInfo = game.players.map(function(p, idx) {
    var territory = 0, totalUnits = 0;
    for (var [k, h] of game.hexes) {
      if (h.owner === idx) { territory++; totalUnits += h.units; }
    }
    return {
      id: p.id, name: p.name, color: p.color, alive: p.alive,
      territory: territory, totalUnits: totalUnits, gold: p.gold
    };
  });

  return {
    myIndex: playerIndex,
    tick: game.tick,
    hexes: hexArray,
    players: playerInfo,
    myKing: player.kingPos,
    legalMoves: legalMoves,
    memory: botMemories[playerIndex] || {}
  };
}

function runBot(playerIndex) {
  var player = game.players[playerIndex];
  if (!player.alive) return [];

  var state = buildBotState(playerIndex);
  var code = player.code;

  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var wrappedCode = `
        "use strict";
        var stateJSON = ${JSON.stringify(JSON.stringify(state))};
        var state = JSON.parse(stateJSON);
        var actions = (function() {
          ${code}
          return decideActions(state);
        })();
        return JSON.stringify({ actions: actions || [], memory: state.memory || {} });
      `;

      var fn = new Function(wrappedCode);
      var resultStr = fn();
      var result = JSON.parse(resultStr);

      // Persist memory
      if (result.memory && typeof result.memory === "object") {
        botMemories[playerIndex] = result.memory;
      }

      return Array.isArray(result.actions) ? result.actions : [];
    } catch (e) {
      console.log("Bot " + player.name + " error (attempt " + (attempt + 1) + "): " + e.message);
    }
  }
  return [];
}

// ============ GAME LOGIC ============

function processTick() {
  if (!game || game.phase !== "playing") return;

  game.tick++;
  game.combatLog = [];

  // 1. Run all bots and collect orders
  var allOrders = [];
  for (var i = 0; i < game.players.length; i++) {
    if (!game.players[i].alive) continue;
    var actions = runBot(i);
    for (var action of actions) {
      if (action && action.from && action.to) {
        allOrders.push({ playerIndex: i, from: action.from, to: action.to });
      }
      // Handle spawn orders
      if (action && action.spawn) {
        processSpawn(i, action.spawn);
      }
    }
  }

  // 2. Process move orders simultaneously
  var pendingMoves = [];  // {playerIndex, fromKey, toKey, units, hasKing}

  for (var order of allOrders) {
    if (!order.from || !order.to) continue;
    var fromKey = hexKey(order.from.q, order.from.r);
    var toKey = hexKey(order.to.q, order.to.r);
    var fromHex = game.hexes.get(fromKey);
    var toHex = game.hexes.get(toKey);

    if (!fromHex || !toHex) continue;
    if (fromHex.owner !== order.playerIndex) continue;
    if (fromHex.units <= 0) continue;
    if (toHex.type === "mountain") continue;

    // Check adjacency
    var dist = hexDistance(fromHex.q, fromHex.r, toHex.q, toHex.r);
    if (dist !== 1) continue;

    // Move units: leave 1 behind unless moving king (king takes all)
    var movingKing = fromHex.hasKing;
    var moveUnits;
    if (movingKing) {
      moveUnits = fromHex.units;
      fromHex.units = 0;
      fromHex.hasKing = false;
      // If leaving empty, lose ownership only if no units remain
    } else {
      moveUnits = fromHex.units - 1;
      if (moveUnits <= 0) continue;
      fromHex.units = 1;
    }

    // If from hex has 0 units and no king, it becomes neutral
    if (fromHex.units === 0 && !fromHex.hasKing) {
      fromHex.owner = null;
    }

    pendingMoves.push({
      playerIndex: order.playerIndex,
      toKey: toKey,
      units: moveUnits,
      hasKing: movingKing
    });
  }

  // Apply moves
  for (var move of pendingMoves) {
    var toHex = game.hexes.get(move.toKey);
    if (toHex.owner === move.playerIndex) {
      // Friendly hex: merge
      toHex.units += move.units;
      if (move.hasKing) {
        toHex.hasKing = true;
        game.players[move.playerIndex].kingPos = { q: toHex.q, r: toHex.r };
      }
    } else if (toHex.owner === null || toHex.units === 0) {
      // Empty/unowned hex: take it
      toHex.owner = move.playerIndex;
      toHex.units = move.units;
      if (move.hasKing) {
        toHex.hasKing = true;
        game.players[move.playerIndex].kingPos = { q: toHex.q, r: toHex.r };
      }
    } else {
      // Enemy hex: combat
      resolveCombat(move, toHex);
    }
  }

  // 3. Check for multi-player conflicts on same hex
  // (already handled by sequential move processing above)

  // 4. Resource generation every RESOURCE_INTERVAL ticks
  if (game.tick % RESOURCE_INTERVAL === 0) {
    for (var [key, hex] of game.hexes) {
      if (hex.type === "resource" && hex.owner !== null) {
        hex.units += 1;
      }
    }
  }

  // 5. Gold from territory
  for (var i = 0; i < game.players.length; i++) {
    if (!game.players[i].alive) continue;
    var territory = 0;
    for (var [k, h] of game.hexes) {
      if (h.owner === i) territory++;
    }
    game.players[i].gold += Math.floor(territory / 10);
  }

  // 6. Check win conditions
  var alivePlayers = game.players.filter(function(p) { return p.alive; });
  if (alivePlayers.length <= 1 || game.tick >= MAX_TICKS) {
    endGame();
    return;
  }

  // Broadcast state
  broadcastState();
}

function processSpawn(playerIndex, spawnPos) {
  var player = game.players[playerIndex];
  if (player.gold < 10) return;  // Cost: 10 gold for 3 units
  var key = hexKey(spawnPos.q, spawnPos.r);
  var hex = game.hexes.get(key);
  if (!hex || hex.owner !== playerIndex) return;
  if (hex.type === "mountain") return;

  player.gold -= 10;
  hex.units += 3;
  game.combatLog.push({
    tick: game.tick,
    type: "spawn",
    player: playerIndex,
    hex: { q: spawnPos.q, r: spawnPos.r },
    units: 3
  });
}

function resolveCombat(move, toHex) {
  var attackerUnits = move.units;
  var defenderUnits = toHex.units;
  var attackerIdx = move.playerIndex;
  var defenderIdx = toHex.owner;

  var logEntry = {
    tick: game.tick,
    type: "combat",
    attacker: attackerIdx,
    defender: defenderIdx,
    hex: { q: toHex.q, r: toHex.r },
    attackerUnits: attackerUnits,
    defenderUnits: defenderUnits
  };

  if (attackerUnits > defenderUnits * COMBAT_RATIO) {
    // Attacker wins
    var losses = Math.floor(defenderUnits / 2);
    var remaining = attackerUnits - losses;

    // Check if defender's king was here
    if (toHex.hasKing) {
      game.players[defenderIdx].alive = false;
      game.players[attackerIdx].gold += 20;
      logEntry.kingCaptured = true;
      logEntry.result = "attacker_wins_king";
      // Clear all defender territory
      // (optional: could leave territory but remove king)
    }

    toHex.owner = attackerIdx;
    toHex.units = Math.max(1, remaining);
    toHex.hasKing = move.hasKing;
    if (move.hasKing) {
      game.players[attackerIdx].kingPos = { q: toHex.q, r: toHex.r };
    }
    logEntry.result = logEntry.result || "attacker_wins";
    logEntry.attackerRemaining = toHex.units;
  } else {
    // Attacker fails: bounce back, lose 1 unit
    // Units are already removed from source, so they're just lost
    logEntry.result = "defender_holds";
    logEntry.attackerLost = attackerUnits;
    // Defender keeps hex, attacker units are destroyed (they already left source)
    // If attacker had king, king is lost! (captured by defender essentially)
    if (move.hasKing) {
      game.players[attackerIdx].alive = false;
      game.players[toHex.owner].gold += 20;
      logEntry.kingLost = true;
    }
  }

  game.combatLog.push(logEntry);
}

function endGame() {
  game.phase = "finished";

  // Determine winner: last alive, or most territory at tick limit
  var alivePlayers = game.players.filter(function(p) { return p.alive; });
  var winner = null;
  var reason = "";

  if (alivePlayers.length === 1) {
    winner = alivePlayers[0].name;
    reason = "Last king standing";
  } else if (alivePlayers.length === 0) {
    reason = "All kings fell";
  } else {
    // Tick limit: most territory wins
    var best = null;
    var bestTerritory = -1;
    for (var p of alivePlayers) {
      var territory = 0;
      for (var [k, h] of game.hexes) {
        if (h.owner === game.players.indexOf(p)) territory++;
      }
      if (territory > bestTerritory) {
        bestTerritory = territory;
        best = p;
      }
    }
    winner = best ? best.name : null;
    reason = "Tick limit (" + MAX_TICKS + ") — most territory";
  }

  // Save to DB
  var playerNames = game.players.map(function(p) { return p.name; });
  db.prepare("INSERT INTO games (id, date, players, winner, reason, ticks) VALUES (?, ?, ?, ?, ?, ?)").run(
    game.id,
    new Date().toISOString(),
    JSON.stringify(playerNames),
    winner,
    reason,
    game.tick
  );

  console.log("Game " + game.id + " finished: " + (winner || "draw") + " — " + reason);

  broadcastState();

  // Broadcast game_over
  var msg = JSON.stringify({
    type: "game_over",
    winner: winner,
    reason: reason,
    ticks: game.tick,
    players: playerNames
  });
  wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });

  // Auto-start new game after 5s
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = null;
  setTimeout(function() { startGame(); }, 5000);
}

function startGame() {
  if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
  game = createGame();
  if (!game) {
    // Try again in 10s
    setTimeout(function() { startGame(); }, 10000);
    return;
  }
  console.log("Starting game " + game.id + " with " + game.players.length + " players: " +
    game.players.map(function(p) { return p.name; }).join(", "));
  broadcastState();
  gameTimer = setInterval(processTick, TICK_MS);
}

// ============ WEBSOCKET ============

function serializeState() {
  if (!game) return JSON.stringify({ type: "state", game: null });

  var hexArray = [];
  for (var [key, hex] of game.hexes) {
    hexArray.push({
      q: hex.q, r: hex.r, type: hex.type,
      owner: hex.owner, units: hex.units, hasKing: hex.hasKing
    });
  }

  var playerInfo = game.players.map(function(p, idx) {
    var territory = 0, totalUnits = 0;
    for (var [k, h] of game.hexes) {
      if (h.owner === idx) { territory++; totalUnits += h.units; }
    }
    return {
      name: p.name, color: p.color, alive: p.alive,
      territory: territory, totalUnits: totalUnits, gold: p.gold,
      kingPos: p.kingPos
    };
  });

  return JSON.stringify({
    type: "state",
    game: {
      id: game.id,
      tick: game.tick,
      phase: game.phase,
      maxTicks: game.maxTicks,
      hexes: hexArray,
      players: playerInfo,
      combatLog: game.combatLog
    }
  });
}

function broadcastState() {
  var msg = serializeState();
  wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

server.on("upgrade", function(req, socket, head) {
  wss.handleUpgrade(req, socket, head, function(ws) {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", function(ws) {
  // Send current state immediately
  ws.send(serializeState());
});

// ============ API ROUTES ============

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/bot/upload", function(req, res) {
  var name = req.body.name;
  var password = req.body.password;
  var code = req.body.code;

  if (!name || !password || !code) {
    return res.status(400).json({ error: "name, password, and code are required" });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "name must be alphanumeric (with _ and -)" });
  }
  if (name.length > 32) {
    return res.status(400).json({ error: "name must be 32 chars or less" });
  }

  var result = saveBot(name, password, code);
  if (result.error) return res.status(403).json(result);
  res.json({ ok: true, message: "Bot '" + name + "' uploaded successfully" });
});

app.get("/api/bots", function(req, res) {
  var bots = loadBots().map(function(b) {
    return { name: b.name, updated: b.updated };
  });
  res.json(bots);
});

app.delete("/api/bot/:name", function(req, res) {
  var result = deleteBot(req.params.name);
  if (result.error) return res.status(404).json(result);
  res.json({ ok: true });
});

app.get("/api/leaderboard", function(req, res) {
  var games = db.prepare("SELECT * FROM games ORDER BY date DESC LIMIT 100").all();
  var stats = {};

  for (var g of games) {
    var players = JSON.parse(g.players);
    for (var p of players) {
      if (!stats[p]) stats[p] = { name: p, wins: 0, games: 0 };
      stats[p].games++;
      if (g.winner === p) stats[p].wins++;
    }
  }

  var leaderboard = Object.values(stats).sort(function(a, b) {
    return b.wins - a.wins || a.games - b.games;
  });

  res.json(leaderboard);
});

app.get("/api/history", function(req, res) {
  var limit = parseInt(req.query.limit) || 10;
  var games = db.prepare("SELECT * FROM games ORDER BY date DESC LIMIT ?").all(limit);
  games.forEach(function(g) { g.players = JSON.parse(g.players); });
  res.json(games);
});

app.get("/api/game/state", function(req, res) {
  if (!game) return res.json({ game: null });

  var hexArray = [];
  for (var [key, hex] of game.hexes) {
    hexArray.push({
      q: hex.q, r: hex.r, type: hex.type,
      owner: hex.owner, units: hex.units, hasKing: hex.hasKing
    });
  }

  var playerInfo = game.players.map(function(p, idx) {
    var territory = 0, totalUnits = 0;
    for (var [k, h] of game.hexes) {
      if (h.owner === idx) { territory++; totalUnits += h.units; }
    }
    return {
      name: p.name, color: p.color, alive: p.alive,
      territory: territory, totalUnits: totalUnits, gold: p.gold,
      kingPos: p.kingPos
    };
  });

  res.json({
    id: game.id,
    tick: game.tick,
    phase: game.phase,
    maxTicks: game.maxTicks,
    hexes: hexArray,
    players: playerInfo,
    combatLog: game.combatLog
  });
});

// ============ START ============

server.listen(PORT, function() {
  console.log("Hex Conquest server running on port " + PORT);
  // Auto-start game loop
  startGame();
});
