"use strict";
const fixture = require("../fixtures/recognition-bridges.json");

module.exports = name => ({ ...fixture.frames[name], index: fixture.index, playerQids: fixture.playerQids });
