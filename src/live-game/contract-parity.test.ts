import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LIVE_GAME_CONTRACT_VERSION,
  LIVE_GAME_MODE_IDS,
} from "./contracts.js";

test("backend constants match the canonical live game v1 contract", async () => {
  const contractUrl = new URL(
    "../../contracts/live-game-v1.json",
    import.meta.url,
  );
  const contract = JSON.parse(await readFile(contractUrl, "utf8")) as {
    contractVersion: number;
    modeIds: string[];
  };

  assert.equal(contract.contractVersion, LIVE_GAME_CONTRACT_VERSION);
  assert.deepEqual(contract.modeIds, LIVE_GAME_MODE_IDS);
});
