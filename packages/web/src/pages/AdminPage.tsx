import type { Question } from '@serverlessq/shared';
import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { AdminForms } from '@/components/AdminForms';
import { AdminGamesTable } from '@/components/AdminGamesTable';
import { useAdminConsole } from '@/hooks/useAdminConsole';

interface AdminPageProps {
  apiBaseUrl: string;
}

export function AdminPage({ apiBaseUrl }: AdminPageProps) {
  const admin = useAdminConsole(apiBaseUrl);
  const [username, setUsername] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [editingQuestion, setEditingQuestion] = useState<Question>();
  const [copyFeedback, setCopyFeedback] = useState<{
    gameId: string;
    failed: boolean;
  }>();

  useEffect(() => {
    if (!admin.authenticated) {
      setEditingQuestion(undefined);
      setCopyFeedback(undefined);
    }
  }, [admin.authenticated]);

  if (admin.restoring)
    return (
      <Container py="20">
        <Spinner aria-label="Restoring administrator session" />
      </Container>
    );
  if (!admin.authenticated) {
    return (
      <Container maxW="xl" py="20">
        <Box
          as="form"
          className="glass-panel admin-card"
          onSubmit={(event) => {
            event.preventDefault();
            const password = passwordDraft;
            setPasswordDraft('');
            void admin.signIn(username.trim(), password);
          }}
        >
          <Text className="eyebrow">HOST CONSOLE</Text>
          <Heading as="h1" size="3xl" mt="2">
            Admin access
          </Heading>
          <Text color="fg.muted" mt="3" mb="6">
            {admin.newPasswordRequired
              ? 'Choose a new password to complete your first sign-in.'
              : 'Sign in with your administrator account. This session ends when you sign out or close this browser tab.'}
          </Text>
          {!admin.newPasswordRequired && (
            <>
              <label className="field-label" htmlFor="admin-email">
                Email
              </label>
              <Input
                id="admin-email"
                type="email"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="text-input"
                autoComplete="username"
                required
              />
            </>
          )}
          <label className="field-label" htmlFor="admin-password">
            {admin.newPasswordRequired ? 'New password' : 'Password'}
          </label>
          <Input
            id="admin-password"
            type="password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            className="text-input"
            autoComplete={admin.newPasswordRequired ? 'new-password' : 'current-password'}
            required
          />
          {admin.error && (
            <Text className="form-error" role="alert">
              {admin.error}
            </Text>
          )}
          <Button
            mt="4"
            type="submit"
            colorPalette="orange"
            disabled={!passwordDraft || admin.busy}
          >
            {admin.newPasswordRequired ? 'Set password' : 'Sign in'}
          </Button>
        </Box>
      </Container>
    );
  }

  const selected = admin.selectedGame;
  const selectedCopyFeedback = copyFeedback?.gameId === selected?.gameId ? copyFeedback : undefined;

  async function copyGameId() {
    if (!selected) return;
    setCopyFeedback(undefined);
    try {
      await navigator.clipboard.writeText(selected.gameId);
      setCopyFeedback({ gameId: selected.gameId, failed: false });
    } catch {
      setCopyFeedback({ gameId: selected.gameId, failed: true });
    }
  }

  return (
    <Container maxW="7xl" py={{ base: '10', md: '14' }}>
      <Flex
        justify="space-between"
        align={{ base: 'flex-start', md: 'center' }}
        direction={{ base: 'column', md: 'row' }}
        gap="5"
        mb="8"
      >
        <Box>
          <HStack gap="2">
            <Badge colorPalette="purple">HOST CONSOLE</Badge>
            <Badge colorPalette="green" variant="subtle">
              {admin.players.length} ACTIVE
            </Badge>
            {selected && <Badge variant="outline">{selected.status}</Badge>}
          </HStack>
          <Heading as="h1" size={{ base: '3xl', md: '4xl' }} mt="3">
            Run the room.
          </Heading>
          <Text color="fg.muted" mt="2">
            Build the question pool, control rounds, and keep the audience moving.
          </Text>
          {admin.error && (
            <Text className="form-error" role="alert">
              {admin.error}
            </Text>
          )}
        </Box>
        <HStack gap="2">
          {admin.loading && <Spinner size="sm" color="orange.400" />}
          <Button type="button" variant="ghost" onClick={() => void admin.refresh()}>
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPasswordDraft('');
              void admin.signOut();
            }}
          >
            Sign out
          </Button>
        </HStack>
      </Flex>

      {admin.games.length > 0 && (
        <Box className="glass-panel admin-toolbar" mb="6">
          <Flex
            gap="4"
            align={{ base: 'stretch', md: 'end' }}
            direction={{ base: 'column', md: 'row' }}
          >
            <Box flex="1" minW="0">
              <Heading as="h2" size="lg">
                Latest games
              </Heading>
              <Text fontSize="sm" color="fg.muted" mt="1">
                Showing up to 10 games, newest first.
              </Text>
              <Text fontWeight="semibold" fontSize="sm" mt="2" overflowWrap="anywhere">
                {selected ? `Selected: ${selected.name ?? selected.gameId}` : 'Select a game'}
              </Text>
            </Box>
            <HStack gap="2" flexWrap="wrap">
              <Button
                type="button"
                variant="outline"
                disabled={!selected}
                onClick={() => void copyGameId()}
              >
                Copy game ID
              </Button>
              {/* Opens in a new tab so the host can throw it on the projector and
                  keep these controls on their own screen. Pinned to the selected
                  game, not the active one, so the projected code cannot drift. */}
              <Button asChild variant="outline" colorPalette="orange" disabled={!selected}>
                <a
                  href={selected ? `/host/${selected.gameId}` : '/host'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Join screen ↗
                </a>
              </Button>
              <Button
                type="button"
                colorPalette="green"
                disabled={!selected || selected.status !== 'LOBBY' || admin.busy}
                onClick={() => void admin.actOnGame('start').catch(() => undefined)}
              >
                Start
              </Button>
              <Button
                type="button"
                colorPalette="orange"
                disabled={
                  !selected ||
                  (selected.status !== 'IN_ROUND' && selected.status !== 'REVEAL') ||
                  admin.busy
                }
                onClick={() => void admin.actOnGame('next').catch(() => undefined)}
              >
                {selected?.status === 'IN_ROUND' ? 'Reveal & score' : 'Next round'}
              </Button>
              {/* Activation is additive, so ended sessions linger on the public
                  directory at `/` until they are explicitly taken off it. */}
              <Button
                type="button"
                variant="outline"
                disabled={!selected || admin.busy}
                onClick={() =>
                  void admin
                    .actOnGame(selected?.active === 'Y' ? 'deactivate' : 'activate')
                    .catch(() => undefined)
                }
              >
                {selected?.active === 'Y' ? 'Unlist' : 'List publicly'}
              </Button>
              <Button
                type="button"
                variant="outline"
                colorPalette="red"
                disabled={!selected || admin.busy}
                onClick={() => {
                  if (window.confirm('Clear all players, answers, and scores for this game?')) {
                    void admin.clearSelectedGame().catch(() => undefined);
                  }
                }}
              >
                Clear game
              </Button>
            </HStack>
          </Flex>
          <Text
            role="status"
            fontSize="sm"
            color={selectedCopyFeedback?.failed ? 'fg.error' : 'fg.muted'}
            mt={selectedCopyFeedback ? '3' : '0'}
          >
            {selectedCopyFeedback &&
              (selectedCopyFeedback.failed
                ? 'Could not copy the game ID. Try again.'
                : 'Game ID copied.')}
          </Text>
          <AdminGamesTable
            games={admin.games}
            questionSets={admin.questionSets}
            selectedGameId={admin.selectedGameId}
            onSelectGame={(gameId) => {
              setCopyFeedback(undefined);
              admin.setSelectedGameId(gameId);
            }}
          />
        </Box>
      )}

      <SimpleGrid columns={{ base: 1, xl: 2 }} gap="6" alignItems="start">
        <AdminForms
          questionSets={admin.questionSets}
          selectedQuestionSetId={admin.selectedQuestionSetId}
          editingQuestion={editingQuestion}
          busy={admin.busy}
          onCreateQuestionSet={admin.addQuestionSet}
          onSaveQuestion={admin.saveQuestion}
          onCancelEdit={() => setEditingQuestion(undefined)}
          onCreateGame={admin.addGame}
        />
        <Stack gap="5">
          <Box className="glass-panel admin-card">
            <Text className="eyebrow">QUESTION POOL · {admin.questions.length} READY</Text>
            <Heading as="h2" size="lg" mt="1" mb="4">
              Prepared questions
            </Heading>
            {/* The pool is per set, so the picker has to sit with the list it
                filters — otherwise the counts above read as the whole table. */}
            {admin.questionSets.length > 0 && (
              <Box mb="4">
                <label className="field-label" htmlFor="pool-question-set">
                  Showing set
                </label>
                <HStack gap="2" align="end">
                  <select
                    id="pool-question-set"
                    className="native-select wide-select"
                    value={admin.selectedQuestionSetId ?? ''}
                    onChange={(event) => admin.setSelectedQuestionSetId(event.target.value)}
                  >
                    {admin.questionSets.map((set) => (
                      <option key={set.questionSetId} value={set.questionSetId}>
                        {set.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    disabled={!admin.selectedQuestionSetId || admin.busy}
                    onClick={() => {
                      const set = admin.selectedQuestionSet;
                      if (!set) return;
                      if (window.confirm(`Delete the question set "${set.name}"?`)) {
                        void admin.removeQuestionSet(set.questionSetId).catch(() => undefined);
                      }
                    }}
                  >
                    Delete set
                  </Button>
                </HStack>
              </Box>
            )}
            <Stack gap="3">
              {admin.questionSets.length === 0 && (
                <Text color="fg.muted">
                  No question sets yet. Create one to start adding questions.
                </Text>
              )}
              {admin.questionSets.length > 0 && admin.questions.length === 0 && (
                <Text color="fg.muted">This set has no questions yet. Add the first one.</Text>
              )}
              {admin.questions.map((question, index) => (
                <Box key={question.questionId} className="question-list-item">
                  <HStack justify="space-between" align="flex-start" gap="4">
                    <HStack align="flex-start" gap="3">
                      <span className="question-number">{index + 1}</span>
                      <Box>
                        <Text fontWeight="semibold">{question.text}</Text>
                        <Text fontSize="sm" color="fg.muted" mt="1">
                          {question.category ?? 'Uncategorized'} · {question.choices.length} choices
                        </Text>
                      </Box>
                    </HStack>
                    <HStack gap="1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditingQuestion(question)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => {
                          if (window.confirm('Delete this question from the pool?')) {
                            void admin.removeQuestion(question.questionId).catch(() => undefined);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </HStack>
                  </HStack>
                </Box>
              ))}
            </Stack>
          </Box>

          <Box className="glass-panel admin-card">
            <HStack justify="space-between" mb="4">
              <Box>
                <Text className="eyebrow">ACTIVE PLAYERS</Text>
                <Heading as="h2" size="lg" mt="1">
                  Lobby pulse
                </Heading>
              </Box>
              <Box className="pulse-orb" aria-hidden="true" />
            </HStack>
            <Stack gap="2">
              {!selected && <Text color="fg.muted">Create or select a game to view players.</Text>}
              {selected && admin.players.length === 0 && (
                <Text color="fg.muted">No players have joined this game yet.</Text>
              )}
              {admin.players.map((player) => (
                <Flex
                  key={player.playerId}
                  className="player-list-item"
                  justify="space-between"
                  align="center"
                  gap="3"
                >
                  <Box minW="0">
                    <Text fontWeight="semibold" truncate>
                      {player.name}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      Joined {new Date(player.joinedAt).toLocaleTimeString()}
                    </Text>
                  </Box>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    disabled={admin.busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${player.name} from the game?`)) {
                        void admin.removePlayer(player.playerId).catch(() => undefined);
                      }
                    }}
                  >
                    Kick
                  </Button>
                </Flex>
              ))}
            </Stack>
          </Box>
        </Stack>
      </SimpleGrid>
    </Container>
  );
}
