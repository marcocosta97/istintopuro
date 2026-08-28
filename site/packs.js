"use strict";

/* Optional league-pack composition, shared by the browser and Node tests. Packs
   use local player ids on disk; this module maps them onto the immutable core
   prefix and deduplicates players shared by two optional countries by QID. */
(function (root, build) {
  const api = build();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LeaguePacks = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  function decodeDeltas(deltas) {
    let total = 0;
    return deltas.map(delta => total += delta);
  }

  function encodeDeltas(ids) {
    return ids.map((id, i) => i ? id - ids[i - 1] : id);
  }

  function validatePack(pack, corePlayers = Infinity) {
    const errors = [];
    const check = (ok, message) => { if (!ok) errors.push(message); };
    check(pack && pack.v === 1, "unsupported pack version");
    check(typeof pack?.id === "string" && /^[a-z0-9-]+$/.test(pack.id), "invalid pack id");
    const players = Array.isArray(pack?.players) ? pack.players : [];
    const clubs = Array.isArray(pack?.clubs) ? pack.clubs : [];
    const postings = Array.isArray(pack?.postings) ? pack.postings : [];
    const apps = Array.isArray(pack?.apps) ? pack.apps : [];
    const goals = Array.isArray(pack?.goals) ? pack.goals : [];
    check(Array.isArray(pack?.leagues) && pack.leagues.length === 2, "pack must contain two leagues");
    check(postings.length === clubs.length, "postings/club count mismatch");
    check(apps.length === clubs.length, "apps/club count mismatch");
    check(goals.length === clubs.length, "goals/club count mismatch");
    const qids = new Set();
    players.forEach((row, i) => {
      check(Array.isArray(row) && row.length === 7, `player ${i}: malformed row`);
      if (!Array.isArray(row)) return;
      check(Number.isInteger(row[0]) && row[0] > 0 && !qids.has(row[0]), `player ${i}: invalid QID`);
      qids.add(row[0]);
      check(Number.isInteger(row[1]) && row[1] >= -1 && row[1] < corePlayers,
        `player ${i}: invalid core id`);
    });
    clubs.forEach((club, ci) => {
      check(Array.isArray(club) && club.length === 6, `club ${ci}: malformed row`);
      const ids = decodeDeltas(postings[ci] || []);
      check(ids.length === (apps[ci] || []).length && ids.length === (goals[ci] || []).length,
        `club ${ci}: posting stats mismatch`);
      check(ids.every((id, i) => Number.isInteger(id) && id >= 0 && id < players.length
        && (!i || id > ids[i - 1])), `club ${ci}: invalid postings`);
    });
    return { ok: errors.length === 0, errors };
  }

  function compose(core, packs) {
    const DB = { ...core,
      leagues: core.leagues.slice(), clubs: core.clubs.slice(), postings: core.postings.slice(),
      apps: core.apps.slice(), goals: core.goals.slice(), names: core.names.slice(),
      births: core.births.slice(), nats: core.nats.slice(), imgs: core.imgs.slice(),
    };
    DB.coreLeagueCount = core.leagues.length;
    DB.coreClubCount = core.clubs.length;
    DB.corePlayerCount = core.names.length;
    DB.clubSource = Array(DB.clubs.length).fill(null);
    DB.playerSource = Array(DB.names.length).fill(null);
    DB.activePacks = [];

    const keepers = new Set(decodeDeltas(core.gks || []));
    const optionalByQid = new Map();
    for (const pack of packs) {
      const checked = validatePack(pack, DB.corePlayerCount);
      if (!checked.ok) throw new Error(`${pack?.id || "pack"}: ${checked.errors.join("; ")}`);
      const leagueOffset = DB.leagues.length;
      const localToGlobal = [];
      pack.players.forEach((row, local) => {
        const [qid, corePid, name, birth, nat, img, gk] = row;
        let pid = corePid;
        if (pid < 0) {
          pid = optionalByQid.get(qid);
          if (pid === undefined) {
            pid = DB.names.length;
            optionalByQid.set(qid, pid);
            DB.names.push(name); DB.births.push(birth); DB.nats.push(nat); DB.imgs.push(img);
            DB.playerSource.push({ pack: pack.id, qid });
          }
        } else {
          const known = optionalByQid.get(qid);
          if (known !== undefined && known !== pid) throw new Error(`${pack.id}: Q${qid} maps to two players`);
          optionalByQid.set(qid, pid);
        }
        if (gk) keepers.add(pid);
        localToGlobal[local] = pid;
      });

      pack.clubs.forEach((club, localClub) => {
        const localIds = decodeDeltas(pack.postings[localClub]);
        const rows = localIds.map((localPid, position) => ({
          pid: localToGlobal[localPid], position,
          apps: pack.apps[localClub][position], goals: pack.goals[localClub][position],
        })).sort((a, b) => a.pid - b.pid);
        const mask = club[2] << leagueOffset;
        const current = club[5] < 0 ? -1 : club[5] + leagueOffset;
        DB.clubs.push([club[0], club[1], mask, club[3], club[4], current]);
        DB.postings.push(encodeDeltas(rows.map(row => row.pid)));
        DB.apps.push(rows.map(row => row.apps));
        DB.goals.push(rows.map(row => row.goals));
        DB.clubSource.push({ pack: pack.id, qid: club[3], order: rows.map(row => row.position) });
      });
      DB.leagues.push(...pack.leagues);
      DB.activePacks.push(pack.id);
    }
    const sortedKeepers = [...keepers].sort((a, b) => a - b);
    DB.gks = encodeDeltas(sortedKeepers);
    return DB;
  }

  return { compose, decodeDeltas, encodeDeltas, validatePack };
});
