// Random two-word names so nobody types (or reveals) a real one.
const ADJECTIVES = ['Quiet', 'Gentle', 'Warm', 'Steady', 'Kind', 'Calm', 'Soft', 'Bright', 'Patient', 'Brave', 'Still', 'Open', 'Mellow', 'Humble', 'Tender', 'Easy'];
const NOUNS = ['River', 'Lantern', 'Sparrow', 'Meadow', 'Harbor', 'Willow', 'Ember', 'Cloud', 'Pebble', 'Garden', 'Window', 'Candle', 'Hill', 'Rain', 'Morning', 'Bridge'];

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

export function randomAlias(random = Math.random) {
  return `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)}`;
}
