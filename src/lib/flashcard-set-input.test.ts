import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import {
  FLASHCARD_SET_LIMITS,
  normalizeFlashcardSetInput,
} from "./flashcard-set-input.js";

function expectApiError(action: () => unknown, code: string): ApiError {
  let captured: ApiError | undefined;
  assert.throws(action, (error) => {
    if (!(error instanceof ApiError)) return false;
    captured = error;
    return error.code === code;
  });
  assert.ok(captured);
  return captured;
}

test("flashcard-set input normalizes text and unique tags", () => {
  const input = normalizeFlashcardSetInput({
    name: "  German basics  ",
    fromLanguage: "   ",
    toLanguage: "  de  ",
    tags: ["  Travel  ", "travel", "Daily\t  Words", "   "],
    words: [
      {
        id: 12,
        word: "  Hallo  ",
        translation: "  Ahoj  ",
        difficulty: 2,
        pronunciation: "   ",
      },
    ],
  });

  assert.deepEqual(input, {
    name: "German basics",
    fromLanguage: null,
    toLanguage: "de",
    tags: ["Travel", "Daily Words"],
    words: [
      {
        id: 12,
        word: "Hallo",
        translation: "Ahoj",
        difficulty: 2,
        pronunciation: null,
      },
    ],
  });
});

test("flashcard-set input rejects duplicate stable word IDs", () => {
  const error = expectApiError(
    () =>
      normalizeFlashcardSetInput({
        name: "Set",
        tags: [],
        words: [
          { id: 4, word: "one", translation: "jedna", difficulty: 1 },
          { id: 4, word: "two", translation: "dva", difficulty: 2 },
        ],
      }),
    "DUPLICATE_WORD_ID",
  );
  assert.deepEqual(error.details, { wordId: 4 });
});

test("flashcard-set input enforces normalized tag and text limits", () => {
  expectApiError(
    () =>
      normalizeFlashcardSetInput({
        name: "Set",
        tags: ["one", "two", "three", "four", "five", "six"],
        words: [{ word: "word", translation: "translation", difficulty: 1 }],
      }),
    "TAG_LIMIT_EXCEEDED",
  );

  const tooLongName = "x".repeat(FLASHCARD_SET_LIMITS.nameLength + 1);
  const error = expectApiError(
    () =>
      normalizeFlashcardSetInput({
        name: tooLongName,
        tags: [],
        words: [{ word: "word", translation: "translation", difficulty: 1 }],
      }),
    "INVALID_FLASHCARD_SET_INPUT",
  );
  assert.deepEqual(error.details, {
    field: "name",
    reason: "TOO_LONG",
    maximumLength: FLASHCARD_SET_LIMITS.nameLength,
    actualLength: FLASHCARD_SET_LIMITS.nameLength + 1,
  });
});

test("flashcard-set input validates card content and difficulty", () => {
  expectApiError(
    () =>
      normalizeFlashcardSetInput({
        name: "Set",
        tags: [],
        words: [{ word: "   ", translation: "translation", difficulty: 1 }],
      }),
    "INVALID_FLASHCARD_SET_INPUT",
  );

  expectApiError(
    () =>
      normalizeFlashcardSetInput({
        name: "Set",
        tags: [],
        words: [{ word: "word", translation: "translation", difficulty: 5 }],
      }),
    "INVALID_FLASHCARD_SET_INPUT",
  );
});
