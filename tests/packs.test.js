"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compose, validatePack } = require("../site/packs.js");

const core = () => ({ built: "2026-08-24", nshards: 2, packs: [],
  leagues: [["Core 1", 1, "IT"], ["Core 2", 2, "IT"]],
  clubs: [["Core Club", "IT", 1, "Q10", 0, 0]],
  postings: [[0]], apps: [[10]], goals: [[1]], gks: [],
  names: ["Core Player"], births: [1990], nats: ["IT"], imgs: [""],
});

function pack(id, qid, basePid = -1) {
  return { v: 1, id, built: "2026-08-24", nshards: 2,
    leagues: [[`${id} 1`, 1, id.toUpperCase()], [`${id} 2`, 2, id.toUpperCase()]],
    clubs: [[`${id} Club`, id.toUpperCase(), 1, `Q${qid + 1}`, 0, 0]],
    players: [[qid, basePid, `${id} Player`, 1992, id.toUpperCase(), "", 0]],
    postings: [[0]], apps: [[20]], goals: [[2]],
  };
}

test("no-pack composition preserves the core arrays and does not mutate its input", () => {
  const input = core(), before = structuredClone(input);
  const result = compose(input, []);
  assert.deepEqual(input, before);
  for (const key of ["leagues", "clubs", "postings", "apps", "goals", "names", "births", "nats", "imgs"])
    assert.deepEqual(result[key], input[key]);
  assert.equal(result.coreClubCount, 1);
  assert.equal(result.corePlayerCount, 1);
});

test("a pack player already in core reuses the core id", () => {
  const result = compose(core(), [pack("pt", 100, 0)]);
  assert.equal(result.names.length, 1);
  assert.deepEqual(result.postings[1], [0]);
  assert.equal(result.apps[1][0], 20);
});

test("two packs sharing an optional QID append one player", () => {
  const result = compose(core(), [pack("pt", 100), pack("be", 100)]);
  assert.equal(result.names.length, 2);
  assert.deepEqual(result.postings.slice(1), [[1], [1]]);
  assert.deepEqual(result.activePacks, ["pt", "be"]);
});

test("posting remaps keep statistics and year permutations aligned", () => {
  const pt = pack("pt", 100);
  pt.players.push([101, 0, "Core duplicate", 1990, "IT", "", 0]);
  pt.postings[0] = [0, 1];
  pt.apps[0] = [20, 10]; pt.goals[0] = [2, 1];
  const result = compose(core(), [pt]);
  assert.deepEqual(result.postings[1], [0, 1]);
  assert.deepEqual(result.apps[1], [10, 20]);
  assert.deepEqual(result.goals[1], [1, 2]);
  assert.deepEqual(result.clubSource[1].order, [1, 0]);
});

test("malformed packs are rejected before composition", () => {
  const pt = pack("pt", 100);
  pt.apps = [];
  const checked = validatePack(pt, 1);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join("\n"), /apps\/club count mismatch/);
  assert.throws(() => compose(core(), [pt]), /apps\/club count mismatch/);
});
