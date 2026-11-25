import { Box, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useState } from 'react';

interface CountdownProps {
  endsAt: number;
  durationSeconds?: number;
  /** `xl` is the projector dial — same markup, read from the back of the room. */
  size?: 'md' | 'xl';
}

export function Countdown({ endsAt, durationSeconds = 45, size = 'md' }: CountdownProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const secondsRemaining = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const progress = useMemo(
    () => Math.min(1, Math.max(0, secondsRemaining / durationSeconds)),
    [durationSeconds, secondsRemaining],
  );

  return (
    <Box
      className={size === 'xl' ? 'countdown countdown-xl' : 'countdown'}
      style={{ '--countdown-progress': `${progress * 360}deg` } as React.CSSProperties}
      aria-label={`${secondsRemaining} seconds remaining`}
      aria-live="polite"
    >
      <Box className="countdown-inner">
        <Text as="strong">{secondsRemaining}</Text>
        <Text as="span">SEC</Text>
      </Box>
    </Box>
  );
}
