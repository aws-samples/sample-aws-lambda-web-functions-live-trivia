import type { Question, QuestionInput, QuestionSet, QuestionSetInput } from '@serverlessq/shared';
import {
  Box,
  Button,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';

interface AdminFormsProps {
  questionSets: QuestionSet[];
  /** The console-wide set selection; seeds both forms' own set pickers. */
  selectedQuestionSetId?: string;
  editingQuestion?: Question;
  busy: boolean;
  onCreateQuestionSet: (input: QuestionSetInput) => Promise<unknown>;
  onSaveQuestion: (input: QuestionInput, questionId?: string) => Promise<unknown>;
  onCancelEdit: () => void;
  onCreateGame: (
    questionSetId: string,
    count: number,
    durationSeconds: number,
    name?: string,
  ) => Promise<unknown>;
}

const emptyChoices = ['', '', '', ''];

export function AdminForms({
  questionSets,
  selectedQuestionSetId,
  editingQuestion,
  busy,
  onCreateQuestionSet,
  onSaveQuestion,
  onCancelEdit,
  onCreateGame,
}: AdminFormsProps) {
  const [setName, setSetName] = useState('');
  const [setDescription, setSetDescription] = useState('');
  const [questionSetId, setQuestionSetId] = useState(selectedQuestionSetId ?? '');
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<string[]>(emptyChoices);
  const [correctChoice, setCorrectChoice] = useState('');
  const [category, setCategory] = useState('');
  const [gameName, setGameName] = useState('');
  const [gameQuestionSetId, setGameQuestionSetId] = useState(selectedQuestionSetId ?? '');
  const [questionCount, setQuestionCount] = useState(6);
  const [duration, setDuration] = useState(20);

  useEffect(() => {
    setText(editingQuestion?.text ?? '');
    setChoices(
      editingQuestion
        ? [...editingQuestion.choices, ...emptyChoices].slice(0, 4)
        : [...emptyChoices],
    );
    setCorrectChoice(editingQuestion?.correctChoice ?? '');
    setCategory(editingQuestion?.category ?? '');
    // Editing shows the question's OWN set (a PUT can move it between sets);
    // a fresh question starts in whichever set the console is pointed at.
    setQuestionSetId(editingQuestion?.questionSetId ?? selectedQuestionSetId ?? '');
  }, [editingQuestion, selectedQuestionSetId]);

  // Track the console selection while the host is not mid-edit of the field.
  useEffect(() => {
    setGameQuestionSetId((current) => current || selectedQuestionSetId || '');
  }, [selectedQuestionSetId]);

  const usableChoices = choices.map((choice) => choice.trim()).filter(Boolean);
  const canSave =
    questionSetId.length > 0 &&
    text.trim().length > 0 &&
    usableChoices.length >= 2 &&
    new Set(usableChoices).size === usableChoices.length &&
    usableChoices.includes(correctChoice);

  const resetQuestion = () => {
    setText('');
    setChoices([...emptyChoices]);
    setCorrectChoice('');
    setCategory('');
    onCancelEdit();
  };

  const questionSetOptions = questionSets.map((set) => (
    <option key={set.questionSetId} value={set.questionSetId}>
      {set.name}
    </option>
  ));

  return (
    <Stack gap="5">
      <Box
        as="form"
        className="glass-panel admin-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !setName.trim()) return;
          void onCreateQuestionSet({
            name: setName.trim(),
            ...(setDescription.trim() ? { description: setDescription.trim() } : {}),
          })
            .then(() => {
              setSetName('');
              setSetDescription('');
            })
            .catch(() => undefined);
        }}
      >
        <Text className="eyebrow">QUESTION SETS · {questionSets.length}</Text>
        <Heading as="h2" size="lg" mt="1" mb="5">
          Add a question set
        </Heading>
        <Stack gap="3">
          <Input
            aria-label="Question set name"
            placeholder="e.g. AWS Trivia Sample"
            value={setName}
            onChange={(event) => setSetName(event.target.value)}
            className="text-input"
            disabled={busy}
          />
          <Input
            aria-label="Question set description"
            placeholder="Description (optional)"
            value={setDescription}
            onChange={(event) => setSetDescription(event.target.value)}
            className="text-input"
            disabled={busy}
          />
          <Button type="submit" colorPalette="orange" disabled={busy || !setName.trim()}>
            {busy ? 'Saving…' : 'Create question set'}
          </Button>
        </Stack>
      </Box>

      <Box
        as="form"
        className="glass-panel admin-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || busy) return;
          const input: QuestionInput = {
            questionSetId,
            text: text.trim(),
            choices: usableChoices,
            correctChoice,
            ...(category.trim() ? { category: category.trim() } : {}),
          };
          void onSaveQuestion(input, editingQuestion?.questionId)
            .then(resetQuestion)
            .catch(() => undefined);
        }}
      >
        <Text className="eyebrow">QUESTION POOL</Text>
        <Heading as="h2" size="lg" mt="1" mb="5">
          {editingQuestion ? 'Edit trivia question' : 'Add a trivia question'}
        </Heading>
        <Stack gap="4">
          <Box>
            <label className="field-label" htmlFor="question-set">
              Question set
            </label>
            <select
              id="question-set"
              className="native-select wide-select"
              value={questionSetId}
              onChange={(event) => setQuestionSetId(event.target.value)}
              disabled={busy || questionSets.length === 0}
            >
              <option value="" disabled>
                {questionSets.length === 0 ? 'Create a question set first' : 'Select a set'}
              </option>
              {questionSetOptions}
            </select>
          </Box>
          <Box>
            <label className="field-label" htmlFor="question-text">
              Question
            </label>
            <Textarea
              id="question-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What do you want the audience to answer?"
              className="text-input"
              rows={3}
              disabled={busy}
            />
          </Box>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
            {choices.map((choice, index) => (
              <Input
                key={index}
                aria-label={`Choice ${String.fromCharCode(65 + index)}`}
                placeholder={`Choice ${String.fromCharCode(65 + index)}`}
                value={choice}
                onChange={(event) => {
                  const next = [...choices];
                  next[index] = event.target.value;
                  setChoices(next);
                  if (correctChoice === choice) setCorrectChoice(event.target.value.trim());
                }}
                className="text-input"
                disabled={busy}
              />
            ))}
          </SimpleGrid>
          <Input
            aria-label="Category"
            placeholder="Category (optional)"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="text-input"
            disabled={busy}
          />
          <HStack justify="space-between" align="end" flexWrap="wrap">
            <Box>
              <label className="field-label" htmlFor="correct-choice">
                Correct answer
              </label>
              <select
                id="correct-choice"
                className="native-select"
                value={correctChoice}
                onChange={(event) => setCorrectChoice(event.target.value)}
                disabled={busy}
              >
                <option value="" disabled>
                  Select a choice
                </option>
                {usableChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </Box>
            <HStack gap="2">
              {editingQuestion && (
                <Button type="button" variant="ghost" onClick={resetQuestion} disabled={busy}>
                  Cancel
                </Button>
              )}
              <Button type="submit" colorPalette="orange" disabled={!canSave || busy}>
                {busy ? 'Saving…' : editingQuestion ? 'Update question' : 'Save question'}
              </Button>
            </HStack>
          </HStack>
        </Stack>
      </Box>

      <Box
        as="form"
        className="glass-panel admin-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !gameQuestionSetId) return;
          void onCreateGame(
            gameQuestionSetId,
            questionCount,
            duration,
            gameName.trim() || undefined,
          )
            .then(() => setGameName(''))
            .catch(() => undefined);
        }}
      >
        <Text className="eyebrow">GAME CONTROL</Text>
        <Heading as="h2" size="lg" mt="1" mb="5">
          Launch the next game
        </Heading>
        <Box mb="3">
          <label className="field-label" htmlFor="game-name">
            Game name (optional)
          </label>
          <Input
            id="game-name"
            value={gameName}
            onChange={(event) => setGameName(event.target.value)}
            placeholder="e.g. Team trivia"
            maxLength={100}
            aria-describedby="game-name-hint"
            className="text-input"
            disabled={busy}
          />
          <Text id="game-name-hint" fontSize="sm" color="fg.muted" mt="1">
            Leave blank to generate a work-safe name.
          </Text>
        </Box>
        <Box mb="3">
          <label className="field-label" htmlFor="game-question-set">
            Draw questions from
          </label>
          <select
            id="game-question-set"
            className="native-select wide-select"
            value={gameQuestionSetId}
            onChange={(event) => setGameQuestionSetId(event.target.value)}
            disabled={busy || questionSets.length === 0}
          >
            <option value="" disabled>
              {questionSets.length === 0 ? 'Create a question set first' : 'Select a set'}
            </option>
            {questionSetOptions}
          </select>
        </Box>
        <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
          <Box>
            <label className="field-label" htmlFor="question-count">
              Questions
            </label>
            <Input
              id="question-count"
              type="number"
              min={1}
              max={100}
              value={questionCount}
              onChange={(event) => setQuestionCount(Number(event.target.value))}
              className="text-input"
              disabled={busy}
            />
          </Box>
          <Box>
            <label className="field-label" htmlFor="round-duration">
              Seconds per round
            </label>
            <Input
              id="round-duration"
              type="number"
              min={1}
              max={600}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              className="text-input"
              disabled={busy}
            />
          </Box>
        </SimpleGrid>
        <Button mt="5" type="submit" colorPalette="orange" disabled={busy || !gameQuestionSetId}>
          {busy ? 'Creating…' : 'Create active game'}
        </Button>
      </Box>
    </Stack>
  );
}
