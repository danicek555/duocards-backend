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
  streakBefore = 0,
): number {
  if (!isCorrect) return 0;
  if (modeId === "accuracy") return 1_000;
  if (modeId === "co_op_mission") return 1;

  const limitMs = Math.max(1, timeLimitSeconds * 1_000);
  const remainingRatio = Math.max(0, 1 - responseTimeMs / limitMs);
  const base = 500 + Math.floor(500 * remainingRatio);
  if (modeId === "streak_combo") {
    return Math.round(base * liveGameStreakMultiplier(streakBefore));
  }
  return base;
}

/**
 * Multiplier applied to the answer that extends a streak: the 1st correct
 * answer scores x1, the 2nd x1.5, the 3rd x2 … capped at x3 (5th+).
 * `streakBefore` is the number of consecutive correct answers so far.
 */
export function liveGameStreakMultiplier(streakBefore: number): number {
  return 1 + Math.min(Math.max(0, streakBefore), 4) * 0.5;
}

/**
 * Survival: players who answered wrong (or not at all) are knocked out at
 * reveal time. Safe-round rule — when every remaining player would be
 * eliminated at once, nobody is, so the game always has a winner.
 */
export function evaluateSurvivalElimination(
  alivePlayers: readonly { id: string; answeredCorrect: boolean }[],
): string[] {
  const losers = alivePlayers.filter((player) => !player.answeredCorrect);
  if (losers.length === 0 || losers.length === alivePlayers.length) return [];
  return losers.map((player) => player.id);
}
