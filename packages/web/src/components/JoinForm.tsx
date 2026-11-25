import { Box, Button, Heading, Input, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';

interface JoinFormProps {
  onJoin: (name: string) => Promise<unknown>;
  busy?: boolean;
  error?: string;
}

export function JoinForm({ onJoin, busy = false, error }: JoinFormProps) {
  const [name, setName] = useState('');
  const trimmedName = name.trim();

  return (
    <Box className="glass-panel join-card">
      <Stack gap="6">
        <Box>
          <Text className="eyebrow">THE NEXT ROUND IS WAITING</Text>
          <Heading as="h1" size={{ base: '3xl', md: '5xl' }} letterSpacing="tight" mt="2">
            Think fast.
            <br />
            <span className="gradient-text">Score faster.</span>
          </Heading>
          <Text color="fg.muted" mt="4" maxW="44ch">
            Pick a display name and join hundreds of players in a live serverless showdown.
          </Text>
        </Box>

        <Box
          as="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName.length >= 1 && !busy) void onJoin(trimmedName).catch(() => undefined);
          }}
        >
          <Stack gap="3">
            <label className="field-label" htmlFor="player-name">
              Display name
            </label>
            <Input
              id="player-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={1}
              maxLength={24}
              size="lg"
              placeholder="e.g. Lambda Legend"
              autoComplete="nickname"
              className="text-input"
              disabled={busy}
            />
            {error && (
              <Text className="form-error" role="alert">
                {error}
              </Text>
            )}
            <Button
              type="submit"
              size="lg"
              colorPalette="orange"
              disabled={trimmedName.length < 1 || busy}
              className="primary-cta"
            >
              {busy ? 'Joining…' : 'Join the game'} {!busy && <span aria-hidden="true">→</span>}
            </Button>
          </Stack>
        </Box>

        <Text fontSize="xs" color="fg.subtle">
          No account needed · Your name and score are cleared after the event
        </Text>
      </Stack>
    </Box>
  );
}
