import { Badge, Box, Container, Flex, HStack, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ColorModeButton } from '@/components/ui/color-mode';

interface AppShellProps {
  apiBaseUrl: string;
  children: ReactNode;
}

/**
 * Deliberately minimal.
 *
 * No player, host, or leaderboard entries: every one of those surfaces needs a
 * specific gameId, and games run in parallel, so a nav link would have to guess
 * which session you meant. Players arrive by scanning a game's QR code (or tapping
 * a row on `/`); hosts open the projected screen from the admin console.
 */
const navItems = [{ to: '/admin', label: 'Admin' }];

export function AppShell({ apiBaseUrl, children }: AppShellProps) {
  return (
    <Box minH="100dvh" className="app-shell">
      <Box as="header" className="site-header">
        <Container maxW="7xl">
          <Flex minH="72px" align="center" justify="space-between" gap="5">
            <NavLink to="/" className="brand" aria-label="ServerlessQ home">
              <img className="brand-mark" src="/logo.svg" alt="" aria-hidden="true" />
              <span>
                <strong>ServerlessQ</strong>
                <small>LIVE TRIVIA</small>
              </span>
            </NavLink>

            <HStack gap={{ base: '2', md: '5' }}>
              <nav className="primary-nav" aria-label="Primary navigation">
                {navItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <ColorModeButton className="theme-toggle" />
            </HStack>
          </Flex>
        </Container>
      </Box>

      <Box as="main">{children}</Box>

      <Box as="footer" className="site-footer">
        <Container maxW="7xl">
          <Flex
            py="6"
            gap="3"
            align={{ base: 'flex-start', md: 'center' }}
            justify="space-between"
            direction={{ base: 'column', md: 'row' }}
          >
            <Text fontSize="sm" color="fg.muted">
              Built with AWS Lambda Web Functions
            </Text>
            <HStack gap="2" minW="0">
              <Badge colorPalette="green" variant="subtle">
                UI SHELL
              </Badge>
              <Text className="endpoint-label" title={apiBaseUrl}>
                API · {apiBaseUrl}
              </Text>
            </HStack>
          </Flex>
        </Container>
      </Box>
    </Box>
  );
}
