'use client';

import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { useEffect } from 'react';
import { ColorModeProvider, type ColorModeProviderProps } from './color-mode';

/**
 * Keep <meta name="theme-color"> in step with the active mode so the browser
 * chrome on phones and tablets is not stuck dark in light mode. A
 * `prefers-color-scheme` media pair cannot do this: next-themes toggles a class
 * and deliberately ignores the OS preference once the user picks a mode.
 *
 * The value is read back from the computed `--page-bg` token, so the palette in
 * styles.css stays the single source of truth.
 */
function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const sync = () => {
      const pageBackground = getComputedStyle(root).getPropertyValue('--page-bg').trim();
      if (pageBackground) meta.setAttribute('content', pageBackground);
    };

    sync();

    // Observe the class rather than reacting to a render: next-themes swaps the
    // class on <html> from its OWN effect, and React runs this child's effects
    // before the parent provider's. Keying off useColorMode() read the outgoing
    // palette and then never re-ran, so the tag stayed dark in light mode.
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return null;
}

export function Provider({ children, ...themeProps }: ColorModeProviderProps) {
  return (
    <ChakraProvider value={defaultSystem}>
      <ColorModeProvider {...themeProps}>
        <ThemeColorSync />
        {children}
      </ColorModeProvider>
    </ChakraProvider>
  );
}
