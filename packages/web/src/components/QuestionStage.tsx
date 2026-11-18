import { Badge, Box, Flex, Heading, HStack, SimpleGrid, Text } from '@chakra-ui/react';
import type { PublicGameState } from '@serverlessq/shared';
import { Countdown } from '@/components/Countdown';

interface QuestionStageProps {
  state: PublicGameState;
}

/**
 * The question as the room sees it, on the projected screen.
 *
 * Read-only by design: the projector never has a player identity, so there is no
 * selection and no submit — those live on the phone. Choices are labelled A–D to
 * match the buttons on the player screen, which is the only thing tying a shout
 * of "C!" to a tap.
 *
 * `correctChoice` is simply absent from the payload while a round is open (the
 * API withholds it, US-B3), so the highlight below cannot leak early even if this
 * component were rendered mid-round — there is nothing to highlight yet.
 */
export function QuestionStage({ state }: QuestionStageProps) {
  const question = state.question;
  if (!question) return null;

  const revealed = state.status === 'REVEAL' || state.status === 'FINISHED';
  const live = state.status === 'IN_ROUND' && state.endsAt !== undefined;

  return (
    <Box className="glass-panel question-stage">
      <Flex justify="space-between" align="flex-start" gap="6">
        <Box minW="0">
          <HStack gap="2" mb="3">
            <Badge colorPalette="orange" size="lg">
              QUESTION {state.questionIndex + 1} OF {state.questionCount}
            </Badge>
            <Badge variant="outline" size="lg" colorPalette={revealed ? 'green' : 'gray'}>
              {revealed ? 'ANSWER' : 'ANSWER ON YOUR PHONE'}
            </Badge>
          </HStack>
          <Heading as="h1" className="stage-question">
            {question.text}
          </Heading>
        </Box>

        {/* The dial only exists while the server says a round is open. At REVEAL it
            is gone rather than frozen at zero — a stopped clock on a projector
            reads as a broken screen. */}
        {live && state.endsAt !== undefined && (
          <Countdown
            endsAt={state.endsAt}
            durationSeconds={state.questionDurationSec}
            size="xl"
          />
        )}
      </Flex>

      <SimpleGrid columns={{ base: 1, md: 2 }} gap={{ base: '3', md: '4' }} mt="8">
        {question.choices.map((choice, index) => {
          const isCorrect = revealed && state.correctChoice === choice;
          return (
            <Box
              key={choice}
              className={isCorrect ? 'stage-choice is-correct' : 'stage-choice'}
              // Announced once, when the highlight appears, rather than on every
              // countdown tick.
              aria-current={isCorrect ? 'true' : undefined}
            >
              <span className="stage-choice-key">{String.fromCharCode(65 + index)}</span>
              <span className="stage-choice-text">{choice}</span>
              {isCorrect && (
                <span className="stage-choice-tick" aria-label="correct answer">
                  ✓
                </span>
              )}
            </Box>
          );
        })}
      </SimpleGrid>

      {revealed && !state.correctChoice && (
        <Text className="stage-note" mt="6">
          Scoring the round…
        </Text>
      )}
    </Box>
  );
}
