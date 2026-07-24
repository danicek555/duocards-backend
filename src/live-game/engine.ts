import { randomInt } from "node:crypto";
import type { LiveGameModeId, LiveGameTeamId } from "./contracts.js";

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

/** Normalized answer with diacritics stripped ("čtyři" → "ctyri"). */
export function normalizeAnswerLoose(raw: string): string {
  return normalizeAnswer(raw).normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * True when the strings are identical up to ONE edit: a substitution,
 * an insertion/deletion, or a swap of two adjacent characters.
 */
export function isWithinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const diff = a.length - b.length;
  if (Math.abs(diff) > 1) return false;

  if (diff === 0) {
    let mismatch = -1;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] === b[index]) continue;
      if (mismatch === -1) {
        mismatch = index;
        continue;
      }
      // A second mismatch is only allowed as an adjacent transposition.
      if (
        index === mismatch + 1 &&
        a[mismatch] === b[index] &&
        a[index] === b[mismatch]
      ) {
        mismatch = -2;
        continue;
      }
      return false;
    }
    return true;
  }

  const longer = diff > 0 ? a : b;
  const shorter = diff > 0 ? b : a;
  let longIndex = 0;
  let shortIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length) {
    if (longer[longIndex] === shorter[shortIndex]) {
      longIndex += 1;
      shortIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

/**
 * Typed-answer check: case- and diacritics-insensitive, and for answers of
 * at least 4 characters one typo (edit) is forgiven.
 */
export function isTypedAnswerCorrect(guess: string, correct: string): boolean {
  const normalizedGuess = normalizeAnswerLoose(guess);
  const normalizedCorrect = normalizeAnswerLoose(correct);
  if (normalizedGuess === normalizedCorrect) return true;
  if (normalizedCorrect.length < 4) return false;
  return isWithinOneEdit(normalizedGuess, normalizedCorrect);
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

/** Sprint: fixed session length, most correct answers wins. */
export const SPRINT_DURATION_SECONDS = 120;
/** Sprint pre-generates a queue no player can realistically exhaust. */
export const SPRINT_QUESTION_COUNT = 50;
/** Marathon: how long the room stays open when the host does not choose. */
export const MARATHON_DEFAULT_DURATION_MINUTES = 24 * 60;
export const MARATHON_MAX_DURATION_MINUTES = 7 * 24 * 60;

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
  // Self-paced modes: flat score, the ranking is simply "most correct".
  if (modeId === "sprint" || modeId === "marathon") return 100;
  // risk_bet points come from the stake (scoreLiveGameBet), not this curve.
  if (modeId === "risk_bet") return 0;

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

/**
 * Risk mode: the stake comes out of the player's bank, a correct answer
 * returns double the stake (net +bet), a wrong one loses it (net -bet).
 */
export function scoreLiveGameBet(isCorrect: boolean, bet: number): number {
  const stake = Math.max(0, Math.floor(bet));
  if (stake === 0) return 0;
  return isCorrect ? stake : -stake;
}

/**
 * Team battle: new players land in the smaller team so sides stay balanced;
 * ties go to RED. Players may still switch manually while in the lobby.
 */
export function pickBalancedLiveGameTeam(
  teams: readonly (LiveGameTeamId | null)[],
): LiveGameTeamId {
  const red = teams.filter((team) => team === "RED").length;
  const blue = teams.filter((team) => team === "BLUE").length;
  return red <= blue ? "RED" : "BLUE";
}
