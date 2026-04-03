#!/usr/bin/env node
/**
 * Hex Conquest Autobattler — local testing harness
 *
 * Usage:
 *   node autobattle.js <bot1.js> <bot2.js> [bot3.js] [bot4.js] [--games=N]
 *
 * Example:
 *   node autobattle.js bots/seb-v11.js bots/bmo.js bots/tinyclaw.js --games=20
 *
 * Runs N games (default 10) and prints win rates.
 * Bot files should contain a decideActions(state) function.
 */

var fs = require("fs");
var crypto = require("crypto");

// ============ CONSTANTS ============
var HEX_RADIUS = 10;
var MAX_TICKS = 200;
var RESOURCE_INTERVAL = 5;
var COMBAT_RATIO = 1.5;
var PLAYER_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
var SPAWN_POSITIONS = [
  { q: 8, r: -8 },
  { q: -8, r: 8 },
  { q: 8, r: 0 },
  { q: -8, r: 0 }
];
var ADJACENT_DIRS = [
  { q: 1, r: 0 }, { q: -1, r: 0 },
  { q: 0, r: 1 }, { q: 0, r: -1 },
  { q: 1, r: -1 }, { q: -1, r: 1 }
];

// ============ HEX MATH ============
function hexKey(q, r) { return q + "," + r; }
function hexDistance(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}
function isValidHex(q, r) { return hexDistance(0, 0, q, r) <= HEX_RADIUS; }
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
  for (var q = -HEX_RADIUS; q <= HEX_RADIUS; q++) {
    for (var r = -HEX_RADIUS; r <= HEX_RADIUS; r++) {
      if (!isValidHex(q, r)) continue;
      hexes.set(hexKey(q, r), { q: q, r: r, type: "plain", owner: null, units: 0, hasKing: false });
    }
  }
  var spawnNeighborKeys = new Set();
  for (var sp of SPAWN_POSITIONS) {
    spawnNeighborKeys.add(hexKey(sp.q, sp.r));
    for (var adj of getAdjacent(sp.q, sp.r)) spawnNeighborKeys.add(hexKey(adj.q, adj.r));
  }
  var allKeys = Array.from(hexes.keys());
  var shuffled = allKeys.slice().sort(function() { return Math.random() - 0.5; });
  var mountainCount = 0;
  for (var key of shuffled) {
    if (mountainCount >= 15) break;
    if (spawnNeighborKeys.has(key)) continue;
    var hex = hexes.get(key);
    if (hex.q === 0 && hex.r === 0) continue;
    hex.type = "mountain";
    mountainCount++;
  }
  var resourceCount = 0;
  shuffled = allKeys.slice().sort(function() { return Math.random() - 0.5; });
  for (var key of shuffled) {
    if (resourceCount >= 8) break;
    var hex = hexes.get(key);
    if (hex.type !== "plain") continue;
    if (spawnNeighborKeys.has(key)) continue;
    var dist = hexDistance(0, 0, hex.q, hex.r);
    if (dist < 3 || dist > 8) continue;
    hex.type = "resource";
    resourceCount++;
  }
  return hexes;
}

// ============ GAME ENGINE ============
function createGame(botCodes) {
  var hexes = generateMap();
  var players = [];
  var botMemories = {};
  for (var i = 0; i < botCodes.length; i++) {
    var spawn = SPAWN_POSITIONS[i];
    var spawnHex = hexes.get(hexKey(spawn.q, spawn.r));
    spawnHex.owner = i;
    spawnHex.units = 5;
    spawnHex.hasKing = true;
    for (var adj of getAdjacent(spawn.q, spawn.r)) {
      var adjHex = hexes.get(hexKey(adj.q, adj.r));
      if (adjHex && adjHex.type !== "mountain") { adjHex.owner = i; adjHex.units = 2; }
    }
    players.push({
      name: botCodes[i].name, color: PLAYER_COLORS[i], alive: true,
      gold: 0, kingPos: { q: spawn.q, r: spawn.r }, code: botCodes[i].code
    });
    botMemories[i] = {};
  }
  return { tick: 0, phase: "playing", hexes: hexes, players: players, combatLog: [], maxTicks: MAX_TICKS, botMemories: botMemories };
}

function buildBotState(game, playerIndex) {
  var player = game.players[playerIndex];
  var hexArray = [];
  var legalMoves = [];
  for (var [key, hex] of game.hexes) {
    hexArray.push({ q: hex.q, r: hex.r, type: hex.type, owner: hex.owner, units: hex.units, hasKing: hex.hasKing });
    if (hex.owner === playerIndex && hex.units > 0) {
      var adjacent = getAdjacent(hex.q, hex.r).filter(function(a) {
        var target = game.hexes.get(hexKey(a.q, a.r));
        return target && target.type !== "mountain";
      });
      if (adjacent.length > 0) legalMoves.push({ from: { q: hex.q, r: hex.r }, adjacent: adjacent });
    }
  }
  var playerInfo = game.players.map(function(p, idx) {
    var territory = 0, totalUnits = 0;
    for (var [k, h] of game.hexes) { if (h.owner === idx) { territory++; totalUnits += h.units; } }
    return { id: p.name, name: p.name, color: p.color, alive: p.alive, territory: territory, totalUnits: totalUnits, gold: p.gold };
  });
  return {
    myIndex: playerIndex, tick: game.tick, hexes: hexArray, players: playerInfo,
    myKing: player.kingPos, legalMoves: legalMoves, memory: game.botMemories[playerIndex] || {}
  };
}

function runBot(game, playerIndex) {
  var player = game.players[playerIndex];
  if (!player.alive) return [];
  var state = buildBotState(game, playerIndex);
  try {
    var wrappedCode = `
      "use strict";
      var stateJSON = ${JSON.stringify(JSON.stringify(state))};
      var state = JSON.parse(stateJSON);
      var actions = (function() {
        ${player.code}
        return decideActions(state);
      })();
      return JSON.stringify({ actions: actions || [], memory: state.memory || {} });
    `;
    var fn = new Function(wrappedCode);
    var result = JSON.parse(fn());
    if (result.memory) game.botMemories[playerIndex] = result.memory;
    return Array.isArray(result.actions) ? result.actions : [];
  } catch (e) {
    return [];
  }
}

function processSpawn(game, playerIndex, spawnPos) {
  var player = game.players[playerIndex];
  if (player.gold < 10) return;
  var key = hexKey(spawnPos.q, spawnPos.r);
  var hex = game.hexes.get(key);
  if (!hex || hex.owner !== playerIndex || hex.type === "mountain") return;
  player.gold -= 10;
  hex.units += 3;
}

function resolveCombat(game, move, toHex) {
  var attackerUnits = move.units;
  var defenderUnits = toHex.units;
  if (attackerUnits > defenderUnits * COMBAT_RATIO) {
    var losses = Math.floor(defenderUnits / 2);
    var remaining = attackerUnits - losses;
    if (toHex.hasKing) {
      game.players[toHex.owner].alive = false;
      game.players[move.playerIndex].gold += 20;
    }
    toHex.owner = move.playerIndex;
    toHex.units = Math.max(1, remaining);
    toHex.hasKing = move.hasKing;
    if (move.hasKing) game.players[move.playerIndex].kingPos = { q: toHex.q, r: toHex.r };
  } else {
    if (move.hasKing) {
      game.players[move.playerIndex].alive = false;
      game.players[toHex.owner].gold += 20;
    }
  }
}

function processTick(game) {
  game.tick++;
  game.combatLog = [];
  var allOrders = [];
  for (var i = 0; i < game.players.length; i++) {
    if (!game.players[i].alive) continue;
    var actions = runBot(game, i);
    for (var action of actions) {
      if (action && action.from && action.to) allOrders.push({ playerIndex: i, from: action.from, to: action.to });
      if (action && action.spawn) processSpawn(game, i, action.spawn);
    }
  }
  var pendingMoves = [];
  for (var order of allOrders) {
    if (!order.from || !order.to) continue;
    var fromHex = game.hexes.get(hexKey(order.from.q, order.from.r));
    var toHex = game.hexes.get(hexKey(order.to.q, order.to.r));
    if (!fromHex || !toHex) continue;
    if (fromHex.owner !== order.playerIndex || fromHex.units <= 0 || toHex.type === "mountain") continue;
    if (hexDistance(fromHex.q, fromHex.r, toHex.q, toHex.r) !== 1) continue;
    var movingKing = fromHex.hasKing;
    var moveUnits;
    if (movingKing) { moveUnits = fromHex.units; fromHex.units = 0; fromHex.hasKing = false; }
    else { moveUnits = fromHex.units - 1; if (moveUnits <= 0) continue; fromHex.units = 1; }
    if (fromHex.units === 0 && !fromHex.hasKing) fromHex.owner = null;
    pendingMoves.push({ playerIndex: order.playerIndex, toKey: hexKey(order.to.q, order.to.r), units: moveUnits, hasKing: movingKing });
  }
  for (var move of pendingMoves) {
    var toHex = game.hexes.get(move.toKey);
    if (toHex.owner === move.playerIndex) {
      toHex.units += move.units;
      if (move.hasKing) { toHex.hasKing = true; game.players[move.playerIndex].kingPos = { q: toHex.q, r: toHex.r }; }
    } else if (toHex.owner === null || toHex.units === 0) {
      toHex.owner = move.playerIndex; toHex.units = move.units;
      if (move.hasKing) { toHex.hasKing = true; game.players[move.playerIndex].kingPos = { q: toHex.q, r: toHex.r }; }
    } else {
      resolveCombat(game, move, toHex);
    }
  }
  if (game.tick % RESOURCE_INTERVAL === 0) {
    for (var [key, hex] of game.hexes) { if (hex.type === "resource" && hex.owner !== null) hex.units += 1; }
  }
  for (var i = 0; i < game.players.length; i++) {
    if (!game.players[i].alive) continue;
    var territory = 0;
    for (var [k, h] of game.hexes) { if (h.owner === i) territory++; }
    game.players[i].gold += Math.floor(territory / 10);
  }
  var alivePlayers = game.players.filter(function(p) { return p.alive; });
  if (alivePlayers.length <= 1 || game.tick >= MAX_TICKS) {
    game.phase = "finished";
    return getWinner(game);
  }
  return null;
}

function getWinner(game) {
  var alivePlayers = game.players.filter(function(p) { return p.alive; });
  if (alivePlayers.length === 1) return { winner: alivePlayers[0].name, reason: "Last king standing", tick: game.tick };
  if (alivePlayers.length === 0) {
    var best = null, bestT = -1;
    for (var p of game.players) {
      var t = 0; for (var [k,h] of game.hexes) { if (h.owner === game.players.indexOf(p)) t++; }
      if (t > bestT) { bestT = t; best = p; }
    }
    return { winner: best ? best.name : "none", reason: "All kings fell", tick: game.tick };
  }
  var best = null, bestT = -1;
  for (var p of alivePlayers) {
    var t = 0; for (var [k,h] of game.hexes) { if (h.owner === game.players.indexOf(p)) t++; }
    if (t > bestT) { bestT = t; best = p; }
  }
  return { winner: best ? best.name : "none", reason: "Tick limit — most territory", tick: game.tick };
}

function runGame(botCodes) {
  var game = createGame(botCodes);
  while (game.phase === "playing") {
    var result = processTick(game);
    if (result) return result;
  }
  return getWinner(game);
}

// ============ CLI ============
function main() {
  var args = process.argv.slice(2);
  var numGames = 10;
  var botFiles = [];
  for (var arg of args) {
    if (arg.startsWith("--games=")) { numGames = parseInt(arg.split("=")[1]) || 10; }
    else { botFiles.push(arg); }
  }
  if (botFiles.length < 2) {
    console.log("Usage: node autobattle.js <bot1.js> <bot2.js> [bot3.js] [bot4.js] [--games=N]");
    console.log("\nBot files should contain a decideActions(state) function.");
    console.log("You can also use bot JSON files from data/bots/*.json");
    process.exit(1);
  }
  var bots = botFiles.map(function(f) {
    var content = fs.readFileSync(f, "utf-8");
    var name = f.replace(/.*\//, "").replace(/\.(js|json)$/, "");
    // Support both raw JS files and JSON bot files
    if (f.endsWith(".json")) {
      var data = JSON.parse(content);
      return { name: data.name || name, code: data.code };
    }
    return { name: name, code: content };
  });

  console.log("=== Hex Conquest Autobattler ===");
  console.log("Bots: " + bots.map(function(b) { return b.name; }).join(", "));
  console.log("Games: " + numGames);
  console.log("");

  var wins = {};
  for (var b of bots) wins[b.name] = 0;

  for (var g = 0; g < numGames; g++) {
    var result = runGame(bots);
    if (wins[result.winner] !== undefined) wins[result.winner]++;
    var pct = Math.round((g + 1) / numGames * 100);
    process.stdout.write("\rGame " + (g + 1) + "/" + numGames + " (" + pct + "%) — " + result.winner + " (" + result.reason + ", tick " + result.tick + ")   ");
  }

  console.log("\n\n=== Results ===");
  var sorted = Object.entries(wins).sort(function(a, b) { return b[1] - a[1]; });
  for (var [name, w] of sorted) {
    var pct = Math.round(w / numGames * 100);
    console.log("  " + name + ": " + w + "/" + numGames + " (" + pct + "%)");
  }
}

main();
