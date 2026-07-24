export const LIVE_GAME_CONTRACT_VERSION = 1 as const;

export const LIVE_GAME_MODE_IDS = [
  "classic_arena",
  "accuracy",
  "co_op_mission",
  "streak_combo",
  "survival",
  "sprint",
  "marathon",
  "team_battle",
  "risk_bet",
] as const;

/**
 * Modes where every player answers their own question queue at their own
 * pace: there is no shared currentQuestion and no host-driven advance —
 * the session runs from start until settings.endsAt.
 */
export const SELF_PACED_MODE_IDS = ["sprint", "marathon"] as const;

export type SelfPacedModeId = (typeof SELF_PACED_MODE_IDS)[number];

export function isSelfPacedModeId(value: string): value is SelfPacedModeId {
  return (SELF_PACED_MODE_IDS as readonly string[]).includes(value);
}

export type LiveGameModeId = (typeof LIVE_GAME_MODE_IDS)[number];

export const LIVE_GAME_SESSION_STATUSES = [
  "LOBBY",
  "QUESTION",
  "REVEAL",
  "FINISHED",
] as const;

export type LiveGameSessionStatus =
  (typeof LIVE_GAME_SESSION_STATUSES)[number];

export type LiveGameTokenRole = "HOST" | "PLAYER";

export const LIVE_GAME_MODE_VERSIONS: Record<LiveGameModeId, number> = {
  classic_arena: 1,
  accuracy: 1,
  co_op_mission: 1,
  streak_combo: 1,
  survival: 1,
  sprint: 1,
  marathon: 1,
  team_battle: 1,
  risk_bet: 1,
};

export const LIVE_GAME_TEAM_IDS = ["RED", "BLUE"] as const;

export type LiveGameTeamId = (typeof LIVE_GAME_TEAM_IDS)[number];

export const LIVE_GAME_ANSWER_MODES = ["choice", "typed"] as const;

export type LiveGameAnswerMode = (typeof LIVE_GAME_ANSWER_MODES)[number];

/** Starting bank every risk_bet player receives on join. */
export const RISK_BET_STARTING_BANK = 1_000;

export interface LiveGameSettings {
  flashcardSetIds: number[];
  questionCount: number;
  questionTimeSeconds: number;
  /** Self-paced only: ISO timestamp when answering closes (set at start). */
  endsAt?: string;
  /** Marathon only: how long the room stays open after start. */
  durationMinutes?: number;
  answerMode: LiveGameAnswerMode;
}

export interface LiveGameParticipantSnapshot {
  id: string;
  nickname: string;
  score: number;
  correct: number;
  total: number;
  /** Consecutive correct answers right now (streak_combo). */
  streak: number;
  bestStreak: number;
  /** Survival: knocked out, but may keep practicing. */
  eliminated: boolean;
  practiceCorrect: number;
  practiceTotal: number;
  /** Team battle: the participant's team, null in other modes. */
  team: LiveGameTeamId | null;
}

export interface LiveGameQuestionSnapshot {
  id: string;
  sequence: number;
  prompt: string;
  options: string[];
  startedAt: string | null;
  locksAt: string | null;
  answeredCount: number;
  correctAnswer?: string;
}

/** Player-scoped question for self-paced modes (no shared currentQuestion). */
export interface LiveGameSelfPacedViewerState {
  question: {
    id: string;
    sequence: number;
    prompt: string;
    options: string[];
  } | null;
  answeredCount: number;
}

export interface LiveGameSessionSnapshot {
  contractVersion: typeof LIVE_GAME_CONTRACT_VERSION;
  id: string;
  roomCode: string;
  modeId: LiveGameModeId;
  modeVersion: number;
  status: LiveGameSessionStatus;
  sequence: number;
  totalQuestions: number;
  /** How players answer: pick one of the options, or type the translation. */
  answerMode: LiveGameAnswerMode;
  serverTime: string;
  currentQuestion: LiveGameQuestionSnapshot | null;
  /** Present for self-paced modes once the session has started. */
  selfPaced: { endsAt: string } | null;
  participants: LiveGameParticipantSnapshot[];
  viewer: {
    participantId: string;
    currentAnswer: {
      roundId: string;
      answer: string;
      isCorrect: boolean;
      points: number;
    } | null;
    selfPaced?: LiveGameSelfPacedViewerState;
  } | null;
}

export function isLiveGameModeId(value: string): value is LiveGameModeId {
  return (LIVE_GAME_MODE_IDS as readonly string[]).includes(value);
}

export function isLiveGameSessionStatus(
  value: string,
): value is LiveGameSessionStatus {
  return (LIVE_GAME_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isLiveGameTeamId(value: string): value is LiveGameTeamId {
  return (LIVE_GAME_TEAM_IDS as readonly string[]).includes(value);
}
