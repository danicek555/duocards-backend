import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuestionDrafts,
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
