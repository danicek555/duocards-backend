import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuestionDrafts,
  evaluateSurvivalElimination,
  liveGameStreakMultiplier,
  normalizeAnswer,
  normalizeLiveGameRoomCode,
  normalizeNickname,
  scoreLiveGameAnswer,
} from "./engine.js";

test("normalizers bound untrusted room, nickname and answer input", () => {
  assert.equal(normalizeLiveGameRoomCode(" ab-c 12!? "), "ABC12");
  assert.equal(normalizeNickname("  Ada\u0000    Lovelace  "), "Ada Lovelace");
  assert.equal(normalizeAnswer("  ČESKÝ   Text  "), "český text");
});

test("question drafts never use the correct answer twice", () => {
  const questions = buildQuestionDrafts(
    [
      { word: "one", translation: "jedna" },
      { word: "two", translation: "dva" },
      { word: "three", translation: "tři" },
      { word: "four", translation: "čtyři" },
    ],
    3,
    20,
  );
  assert.equal(questions.length, 3);
  for (const question of questions) {
    assert.equal(
      question.options.filter(
        (option) => normalizeAnswer(option) === normalizeAnswer(question.correctAnswer),
      ).length,
      1,
    );
  }
});

test("scoring rewards correctness and bounds the speed bonus", () => {
  assert.equal(scoreLiveGameAnswer("classic_arena", false, 0, 20), 0);
  assert.equal(scoreLiveGameAnswer("classic_arena", true, 0, 20), 1_000);
  assert.equal(scoreLiveGameAnswer("classic_arena", true, 30_000, 20), 500);
  assert.equal(scoreLiveGameAnswer("accuracy", true, 1, 20), 1_000);
  assert.equal(scoreLiveGameAnswer("co_op_mission", true, 1, 20), 1);
});

test("streak combo multiplies the base score and caps at x3", () => {
  assert.equal(liveGameStreakMultiplier(0), 1);
  assert.equal(liveGameStreakMultiplier(1), 1.5);
  assert.equal(liveGameStreakMultiplier(2), 2);
  assert.equal(liveGameStreakMultiplier(4), 3);
  assert.equal(liveGameStreakMultiplier(99), 3);
  assert.equal(scoreLiveGameAnswer("streak_combo", true, 0, 20, 0), 1_000);
  assert.equal(scoreLiveGameAnswer("streak_combo", true, 0, 20, 2), 2_000);
  assert.equal(scoreLiveGameAnswer("streak_combo", true, 30_000, 20, 99), 1_500);
  assert.equal(scoreLiveGameAnswer("streak_combo", false, 0, 20, 5), 0);
});

test("survival eliminates wrong answers but never the whole field", () => {
  assert.deepEqual(
    evaluateSurvivalElimination([
      { id: "a", answeredCorrect: true },
      { id: "b", answeredCorrect: false },
      { id: "c", answeredCorrect: false },
    ]),
    ["b", "c"],
  );
  // Safe round: everyone failed, nobody drops.
  assert.deepEqual(
    evaluateSurvivalElimination([
      { id: "a", answeredCorrect: false },
      { id: "b", answeredCorrect: false },
    ]),
    [],
  );
  assert.deepEqual(
    evaluateSurvivalElimination([{ id: "a", answeredCorrect: true }]),
    [],
  );
});
