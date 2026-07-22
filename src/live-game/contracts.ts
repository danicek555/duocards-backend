export const LIVE_GAME_CONTRACT_VERSION = 1 as const;

export const LIVE_GAME_MODE_IDS = [
  "classic_arena",
  "accuracy",
  "co_op_mission",
] as const;

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
};

export interface LiveGameSettings {
  flashcardSetIds: number[];
  questionCount: number;
  questionTimeSeconds: number;
}

export interface LiveGameParticipantSnapshot {
  id: string;
  nickname: string;
  score: number;
  correct: number;
  total: number;
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

export interface LiveGameSessionSnapshot {
  contractVersion: typeof LIVE_GAME_CONTRACT_VERSION;
  id: string;
  roomCode: string;
  modeId: LiveGameModeId;
  modeVersion: number;
  status: LiveGameSessionStatus;
  sequence: number;
  totalQuestions: number;
  serverTime: string;
  currentQuestion: LiveGameQuestionSnapshot | null;
  participants: LiveGameParticipantSnapshot[];
  viewer: {
    participantId: string;
    currentAnswer: {
      roundId: string;
      answer: string;
      isCorrect: boolean;
      points: number;
    } | null;
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
