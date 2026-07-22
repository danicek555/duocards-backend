import { randomInt } from "node:crypto";
import type { LiveGameModeId } from "./contracts.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface LiveGameWordSource {
  word: string;
  translation: string;
}

export interface LiveGameQuestionDraft {
  sequence: number;
  prompt: string;
  correctAnswer: string;
  options: string[];
  timeLimitSeconds: number;
}

export function generateLiveGameRoomCode(): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeLiveGameRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, 8);
}

export function normalizeNickname(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 40);
}

export function normalizeAnswer(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function shuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export function buildQuestionDrafts(
  words: readonly LiveGameWordSource[],
  questionCount: number,
  timeLimitSeconds: number,
): LiveGameQuestionDraft[] {
  const usableWords = words.filter(
    (word) => word.word.trim().length > 0 && word.translation.trim().length > 0,
  );
  const uniqueAnswers = Array.from(
    new Map(
      usableWords.map((word) => [
        normalizeAnswer(word.translation),
        word.translation.trim(),
      ]),
    ).values(),
  );

  if (usableWords.length === 0 || uniqueAnswers.length < 2) return [];

  return shuffle(usableWords)
    .slice(0, Math.min(questionCount, usableWords.length))
    .map((word, index) => {
      const correctAnswer = word.translation.trim();
      const distractors = shuffle(
        uniqueAnswers.filter(
          (candidate) => normalizeAnswer(candidate) !== normalizeAnswer(correctAnswer),
        ),
      ).slice(0, 3);
      return {
        sequence: index + 1,
        prompt: word.word.trim(),
        correctAnswer,
        options: shuffle([correctAnswer, ...distractors]),
        timeLimitSeconds,
      };
    });
}

export function scoreLiveGameAnswer(
  modeId: LiveGameModeId,
  isCorrect: boolean,
  responseTimeMs: number,
  timeLimitSeconds: number,
): number {
  if (!isCorrect) return 0;
  if (modeId === "accuracy") return 1_000;
  if (modeId === "co_op_mission") return 1;

  const limitMs = Math.max(1, timeLimitSeconds * 1_000);
  const remainingRatio = Math.max(0, 1 - responseTimeMs / limitMs);
  return 500 + Math.floor(500 * remainingRatio);
}
