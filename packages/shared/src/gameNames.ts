import { randomInt } from 'node:crypto';

// Fixed, neutral words keep generated names suitable for a workplace audience.
const adjectives = [
  'Bright',
  'Calm',
  'Clever',
  'Cosmic',
  'Gentle',
  'Golden',
  'Happy',
  'Kind',
  'Lively',
  'Mighty',
  'Quiet',
  'Silver',
  'Sunny',
  'Swift',
  'Warm',
  'Wise',
];

const nouns = [
  'Badger',
  'Cedar',
  'Comet',
  'Dolphin',
  'Falcon',
  'Maple',
  'Meadow',
  'Orbit',
  'Otter',
  'Panda',
  'Pebble',
  'Penguin',
  'River',
  'Robin',
  'Sparrow',
  'Willow',
];

export function generateGameName(): string {
  const adjective = adjectives[randomInt(adjectives.length)]!;
  const noun = nouns[randomInt(nouns.length)]!;
  // The suffix helps distinguish games that draw the same pair of words.
  return `${adjective} ${noun} ${randomInt(1000, 10000)}`;
}
