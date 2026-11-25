import { Box, Text } from '@chakra-ui/react';
import { QRCodeSVG } from 'qrcode.react';

interface JoinQrProps {
  /** Absolute URL to encode — players land here after scanning. */
  url: string;
  /**
   * Upper bound on the rendered edge length in px. The SVG itself is fluid
   * (`width: 100%`), so this caps the plate on a wide projector while still
   * letting the code shrink to fit a phone.
   */
  size?: number;
  /** Show the URL underneath, for anyone whose camera will not cooperate. */
  showUrl?: boolean;
}

/**
 * Scannable join code.
 *
 * Deliberately not themed: the modules stay near-black on white in both color
 * modes. This panel is projected in a dark room onto a screen of unknown gamma,
 * and an inverted (light-on-dark) code is rejected by a fair number of phone
 * cameras. `marginSize={2}` keeps the required quiet zone inside the SVG so the
 * surrounding card can never crowd the finder patterns.
 *
 * Error correction is 'M' rather than the library default 'L': a projected code
 * gets photographed at an angle, through glare, from the back of the room, and
 * the extra redundancy costs only a slightly denser grid at this URL length.
 */
export function JoinQr({ url, size = 320, showUrl = true }: JoinQrProps) {
  return (
    <Box className="qr-card">
      {/* Caps the plate, overriding the stylesheet default so `size` is the one
          knob callers need for how large the code lands on screen. */}
      <Box className="qr-frame" style={{ maxWidth: `${size}px` }}>
        <QRCodeSVG
          value={url}
          size={size}
          level="M"
          marginSize={2}
          bgColor="#ffffff"
          fgColor="#10131c"
          title={`Scan to join: ${url}`}
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
      </Box>
      {showUrl && (
        <Text className="qr-url" title={url}>
          {url.replace(/^https?:\/\//, '')}
        </Text>
      )}
    </Box>
  );
}
