import { ApiError } from "./errors.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const FLASHCARD_SET_LIMITS = {
  setsPerUser: 100,
  wordsPerSet: 100,
  tagsPerSet: 5,
  tagsPerUser: 20,
  nameLength: 120,
  languageLength: 64,
  tagLength: 40,
  wordLength: 500,
  translationLength: 1_000,
  pronunciationLength: 500,
  minimumDifficulty: 1,
  maximumDifficulty: 4,
} as const;

export interface FlashcardWordInput {
  id?: number;
  word: string;
  translation: string;
  difficulty: number;
  pronunciation?: string | null;
}

export interface FlashcardSetInput {
  name: string;
  fromLanguage?: string | null;
  toLanguage?: string | null;
  tags: string[];
  words: FlashcardWordInput[];
}

export interface NormalizedFlashcardWordInput {
  id?: number;
  word: string;
  translation: string;
  difficulty: number;
  pronunciation: string | null;
}

export interface NormalizedFlashcardSetInput {
  name: string;
  fromLanguage: string | null;
  toLanguage: string | null;
  tags: string[];
  words: NormalizedFlashcardWordInput[];
}

const nullableRawTextSchema = (maxLength: number) => ({
  anyOf: [
    { type: "string", maxLength },
    { type: "null" },
  ],
});

export const flashcardSetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "tags", "words"],
  properties: {
    name: { type: "string", maxLength: 256 },
    fromLanguage: nullableRawTextSchema(128),
    toLanguage: nullableRawTextSchema(128),
    tags: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 128 },
    },
    words: {
      type: "array",
      minItems: 1,
      maxItems: FLASHCARD_SET_LIMITS.wordsPerSet,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["word", "translation", "difficulty"],
        properties: {
          id: {
            type: "integer",
            minimum: 1,
            maximum: POSTGRES_INTEGER_MAX,
          },
          word: { type: "string", maxLength: 1_000 },
          translation: { type: "string", maxLength: 2_000 },
          difficulty: {
            type: "integer",
            minimum: FLASHCARD_SET_LIMITS.minimumDifficulty,
            maximum: FLASHCARD_SET_LIMITS.maximumDifficulty,
          },
          pronunciation: nullableRawTextSchema(1_000),
        },
      },
    },
  },
} as const;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function invalidInput(
  field: string,
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
): never {
  throw new ApiError(400, "INVALID_FLASHCARD_SET_INPUT", message, {
    field,
    reason,
    ...details,
  });
}

function normalizeRequiredText(
  value: string,
  field: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) {
    return invalidInput(field, `${label} is required`, "REQUIRED");
  }
  const length = codePointLength(normalized);
  if (length > maximumLength) {
    return invalidInput(
      field,
      `${label} must contain at most ${maximumLength} characters`,
      "TOO_LONG",
      { maximumLength, actualLength: length },
    );
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  label: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const length = codePointLength(normalized);
  if (length > maximumLength) {
    return invalidInput(
      field,
      `${label} must contain at most ${maximumLength} characters`,
      "TOO_LONG",
      { maximumLength, actualLength: length },
    );
  }
  return normalized;
}

export function canonicalTagKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function normalizeTags(values: string[]): string[] {
  const normalizedTags: string[] = [];
  const seenKeys = new Set<string>();

  for (const value of values) {
    const normalized = value
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ");
    if (!normalized) continue;

    const length = codePointLength(normalized);
    if (length > FLASHCARD_SET_LIMITS.tagLength) {
      return invalidInput(
        "tags",
        `Each tag must contain at most ${FLASHCARD_SET_LIMITS.tagLength} characters`,
        "TAG_TOO_LONG",
        {
          maximumLength: FLASHCARD_SET_LIMITS.tagLength,
          actualLength: length,
        },
      );
    }

    const key = canonicalTagKey(normalized);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    normalizedTags.push(normalized);
  }

  if (normalizedTags.length > FLASHCARD_SET_LIMITS.tagsPerSet) {
    throw new ApiError(
      400,
      "TAG_LIMIT_EXCEEDED",
      `A flashcard set may contain at most ${FLASHCARD_SET_LIMITS.tagsPerSet} unique tags`,
      {
        maximum: FLASHCARD_SET_LIMITS.tagsPerSet,
        actual: normalizedTags.length,
      },
    );
  }

  return normalizedTags;
}

function normalizeWord(
  input: FlashcardWordInput,
  index: number,
  seenIds: Set<number>,
): NormalizedFlashcardWordInput {
  if (input.id !== undefined) {
    if (
      !Number.isInteger(input.id) ||
      input.id < 1 ||
      input.id > POSTGRES_INTEGER_MAX
    ) {
      return invalidInput(
        `words[${index}].id`,
        "Word ID must be a positive PostgreSQL integer",
        "INVALID_ID",
      );
    }
    if (seenIds.has(input.id)) {
      throw new ApiError(
        400,
        "DUPLICATE_WORD_ID",
        "Each existing word ID may appear only once",
        { wordId: input.id },
      );
    }
    seenIds.add(input.id);
  }

  if (
    !Number.isInteger(input.difficulty) ||
    input.difficulty < FLASHCARD_SET_LIMITS.minimumDifficulty ||
    input.difficulty > FLASHCARD_SET_LIMITS.maximumDifficulty
  ) {
    return invalidInput(
      `words[${index}].difficulty`,
      `Difficulty must be an integer between ${FLASHCARD_SET_LIMITS.minimumDifficulty} and ${FLASHCARD_SET_LIMITS.maximumDifficulty}`,
      "OUT_OF_RANGE",
      {
        minimum: FLASHCARD_SET_LIMITS.minimumDifficulty,
        maximum: FLASHCARD_SET_LIMITS.maximumDifficulty,
      },
    );
  }

  const normalized = {
    word: normalizeRequiredText(
      input.word,
      `words[${index}].word`,
      "Word",
      FLASHCARD_SET_LIMITS.wordLength,
    ),
    translation: normalizeRequiredText(
      input.translation,
      `words[${index}].translation`,
      "Translation",
      FLASHCARD_SET_LIMITS.translationLength,
    ),
    difficulty: input.difficulty,
    pronunciation: normalizeOptionalText(
      input.pronunciation,
      `words[${index}].pronunciation`,
      "Pronunciation",
      FLASHCARD_SET_LIMITS.pronunciationLength,
    ),
  };

  return input.id === undefined ? normalized : { id: input.id, ...normalized };
}

export function normalizeFlashcardSetInput(
  input: FlashcardSetInput,
): NormalizedFlashcardSetInput {
  if (
    !Array.isArray(input.words) ||
    input.words.length < 1 ||
    input.words.length > FLASHCARD_SET_LIMITS.wordsPerSet
  ) {
    return invalidInput(
      "words",
      `A flashcard set must contain between 1 and ${FLASHCARD_SET_LIMITS.wordsPerSet} words`,
      "CARD_COUNT_OUT_OF_RANGE",
      { minimum: 1, maximum: FLASHCARD_SET_LIMITS.wordsPerSet },
    );
  }

  const seenIds = new Set<number>();
  return {
    name: normalizeRequiredText(
      input.name,
      "name",
      "Flashcard set name",
      FLASHCARD_SET_LIMITS.nameLength,
    ),
    fromLanguage: normalizeOptionalText(
      input.fromLanguage,
      "fromLanguage",
      "Source language",
      FLASHCARD_SET_LIMITS.languageLength,
    ),
    toLanguage: normalizeOptionalText(
      input.toLanguage,
      "toLanguage",
      "Target language",
      FLASHCARD_SET_LIMITS.languageLength,
    ),
    tags: normalizeTags(input.tags),
    words: input.words.map((word, index) =>
      normalizeWord(word, index, seenIds),
    ),
  };
}
