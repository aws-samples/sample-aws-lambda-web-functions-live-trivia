import type {
  CreateGameRequest,
  Game,
  Participant,
  Question,
  QuestionInput,
  QuestionSet,
  QuestionSetInput,
} from '@serverlessq/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AdminSessionDenied,
  currentAdminAccessToken,
  finishNewPassword,
  signInAdmin,
  signOutAdmin,
} from '@/auth/adminSession';
import { getLatestGames } from '@/utils/games';
import {
  clearGame as clearGameRequest,
  createGame,
  createQuestion,
  createQuestionSet,
  deleteQuestion,
  deleteQuestionSet,
  kickPlayer,
  listGames,
  listPlayers,
  listQuestions,
  listQuestionSets,
  runGameAction,
  updateQuestion,
  ApiClientError,
} from '@/api/client';

const PLAYER_POLL_MS = 2_000;

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function useAdminConsole(apiBaseUrl: string) {
  const [authenticated, setAuthenticated] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [newPasswordRequired, setNewPasswordRequired] = useState(false);
  const sessionEpoch = useRef(0);
  const [questionSets, setQuestionSets] = useState<QuestionSet[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [players, setPlayers] = useState<Participant[]>([]);
  const [selectedQuestionSetId, setSelectedQuestionSetId] = useState<string>();
  const [selectedGameId, setSelectedGameId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const clearSession = useCallback(() => {
    sessionEpoch.current++;
    setAuthenticated(false);
    setNewPasswordRequired(false);
    setQuestionSets([]);
    setQuestions([]);
    setGames([]);
    setPlayers([]);
    setSelectedQuestionSetId(undefined);
    setSelectedGameId(undefined);
    setLoading(false);
    setBusy(false);
  }, []);
  const handleError = useCallback(
    (failure: unknown) => {
      if (
        failure instanceof AdminSessionDenied ||
        (failure instanceof ApiClientError && (failure.status === 401 || failure.status === 403))
      ) {
        clearSession();
        void signOutAdmin().catch(() => undefined);
      }
      setError(messageFrom(failure));
    },
    [clearSession],
  );
  const signOut = useCallback(async () => {
    clearSession();
    setError(undefined);
    try {
      await signOutAdmin();
    } catch (failure) {
      setError(messageFrom(failure));
    }
  }, [clearSession]);
  const signIn = async (username: string, password: string) => {
    const epoch = sessionEpoch.current;
    setBusy(true);
    setError(undefined);
    try {
      const step = newPasswordRequired
        ? await finishNewPassword(password)
        : await signInAdmin(username, password);
      if (epoch !== sessionEpoch.current) return;
      setNewPasswordRequired(step === 'new-password');
      if (step === 'signed-in') {
        await currentAdminAccessToken();
        if (epoch === sessionEpoch.current) setAuthenticated(true);
      }
    } catch (failure) {
      if (epoch === sessionEpoch.current) handleError(failure);
    } finally {
      if (epoch === sessionEpoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    void currentAdminAccessToken()
      .then(() => {
        if (!disposed) setAuthenticated(true);
      })
      .catch(async (failure: unknown) => {
        if (!disposed && failure instanceof AdminSessionDenied) {
          clearSession();
          await signOutAdmin().catch(() => undefined);
        }
      })
      .finally(() => {
        if (!disposed) setRestoring(false);
      });
    return () => {
      disposed = true;
    };
  }, [clearSession]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!authenticated) return;
      const epoch = sessionEpoch.current;
      setLoading(true);
      setError(undefined);
      try {
        const [setResult, gameResult] = await Promise.all([
          currentAdminAccessToken().then((token) => listQuestionSets(apiBaseUrl, token, signal)),
          currentAdminAccessToken().then((token) => listGames(apiBaseUrl, token, signal)),
        ]);
        const latestGames = getLatestGames(gameResult.games);
        if (signal?.aborted || epoch !== sessionEpoch.current) return;

        // The pool view follows the selected set, so the set has to be resolved
        // before the questions can be fetched — fall back to the first set when
        // the current selection was deleted or nothing is selected yet.
        const setStillExists = setResult.questionSets.some(
          (set) => set.questionSetId === selectedQuestionSetId,
        );
        const questionSetId = setStillExists
          ? selectedQuestionSetId
          : setResult.questionSets[0]?.questionSetId;
        const nextQuestions = questionSetId
          ? (
              await listQuestions(
                apiBaseUrl,
                await currentAdminAccessToken(),
                questionSetId,
                signal,
              )
            ).questions
          : [];

        const selectedStillExists = latestGames.some((game) => game.gameId === selectedGameId);
        const gameId = selectedStillExists
          ? selectedGameId
          : (latestGames.find((game) => game.active === 'Y')?.gameId ?? latestGames[0]?.gameId);
        const nextPlayers = gameId
          ? (await listPlayers(apiBaseUrl, await currentAdminAccessToken(), gameId, signal)).players
          : [];
        if (signal?.aborted || epoch !== sessionEpoch.current) return;
        setQuestionSets(setResult.questionSets);
        setGames(latestGames);
        setSelectedQuestionSetId(questionSetId);
        setQuestions(nextQuestions);
        setSelectedGameId(gameId);
        setPlayers(nextPlayers);
      } catch (refreshError) {
        if (!(refreshError instanceof DOMException && refreshError.name === 'AbortError')) {
          if (epoch === sessionEpoch.current) handleError(refreshError);
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiBaseUrl, selectedGameId, selectedQuestionSetId, authenticated, handleError],
  );

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, authenticated]);

  useEffect(() => {
    if (!authenticated || !selectedGameId) return;
    const epoch = sessionEpoch.current;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await listPlayers(
          apiBaseUrl,
          await currentAdminAccessToken(),
          selectedGameId,
          controller.signal,
        );
        if (!disposed && epoch === sessionEpoch.current) setPlayers(result.players);
      } catch (pollError) {
        if (!disposed && epoch === sessionEpoch.current) handleError(pollError);
      } finally {
        if (!disposed && epoch === sessionEpoch.current)
          timer = window.setTimeout(() => void poll(), PLAYER_POLL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiBaseUrl, selectedGameId, authenticated, handleError]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>, refreshAfter = true) => {
      const epoch = sessionEpoch.current;
      setBusy(true);
      setError(undefined);
      try {
        await action();
        if (refreshAfter && epoch === sessionEpoch.current) await refresh();
      } catch (mutationError) {
        if (epoch === sessionEpoch.current) handleError(mutationError);
        throw mutationError;
      } finally {
        setBusy(false);
      }
    },
    [refresh, handleError],
  );

  const addQuestionSet = (input: QuestionSetInput) =>
    mutate(async () => {
      const epoch = sessionEpoch.current;
      const created = await createQuestionSet(apiBaseUrl, await currentAdminAccessToken(), input);
      // Select the new set so the pool view and both forms land on it, rather
      // than leaving the host looking at the set they just moved off.
      if (epoch === sessionEpoch.current) setSelectedQuestionSetId(created.questionSetId);
    });

  const removeQuestionSet = (questionSetId: string) =>
    mutate(async () =>
      deleteQuestionSet(apiBaseUrl, await currentAdminAccessToken(), questionSetId),
    );

  const saveQuestion = (input: QuestionInput, questionId?: string) =>
    mutate(async () =>
      questionId
        ? updateQuestion(apiBaseUrl, await currentAdminAccessToken(), questionId, input)
        : createQuestion(apiBaseUrl, await currentAdminAccessToken(), input),
    );

  const removeQuestion = (questionId: string) =>
    mutate(async () => deleteQuestion(apiBaseUrl, await currentAdminAccessToken(), questionId));

  /** Draw a fresh game from one question set (the set is required server-side). */
  const addGame = (
    questionSetId: string,
    count: number,
    questionDurationSec: number,
    name?: string,
  ) => {
    const body: CreateGameRequest = {
      ...(name?.trim() ? { name: name.trim() } : {}),
      selection: { questionSetId, count, shuffle: true },
      questionDurationSec,
      activate: true,
    };
    return mutate(async () => {
      const epoch = sessionEpoch.current;
      const created = await createGame(apiBaseUrl, await currentAdminAccessToken(), body);
      if (epoch === sessionEpoch.current) setSelectedGameId(created.gameId);
    }, false);
  };

  const actOnGame = (action: 'start' | 'next' | 'activate' | 'deactivate') => {
    if (!selectedGameId) return Promise.reject(new Error('Select a game first'));
    return mutate(async () =>
      runGameAction(apiBaseUrl, await currentAdminAccessToken(), selectedGameId, action),
    );
  };

  const clearSelectedGame = () => {
    if (!selectedGameId) return Promise.reject(new Error('Select a game first'));
    return mutate(async () =>
      clearGameRequest(apiBaseUrl, await currentAdminAccessToken(), selectedGameId),
    );
  };

  const removePlayer = (playerId: string) => {
    if (!selectedGameId) return Promise.reject(new Error('Select a game first'));
    return mutate(async () =>
      kickPlayer(apiBaseUrl, await currentAdminAccessToken(), selectedGameId, playerId),
    );
  };

  return {
    authenticated,
    restoring,
    newPasswordRequired,
    signIn,
    signOut,
    questionSets,
    questions,
    games,
    players,
    selectedQuestionSetId,
    setSelectedQuestionSetId,
    selectedQuestionSet: questionSets.find((set) => set.questionSetId === selectedQuestionSetId),
    selectedGameId,
    setSelectedGameId,
    selectedGame: games.find((game) => game.gameId === selectedGameId),
    loading,
    busy,
    error,
    refresh,
    addQuestionSet,
    removeQuestionSet,
    saveQuestion,
    removeQuestion,
    addGame,
    actOnGame,
    clearSelectedGame,
    removePlayer,
  };
}
