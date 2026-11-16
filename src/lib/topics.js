// The fixed set of topics used for matching. Keys are stored in the database;
// labels are what people see.
export const TOPICS = [
  { key: 'relationships', label: 'Relationships', words: ['boyfriend', 'girlfriend', 'partner', 'husband', 'wife', 'breakup', 'broke up', 'cheat', 'dating', 'ex', 'marriage', 'divorce', 'crush', 'love'] },
  { key: 'family', label: 'Family', words: ['mom', 'mother', 'dad', 'father', 'parent', 'parents', 'sister', 'brother', 'family', 'in-laws', 'son', 'daughter', 'kids', 'home'] },
  { key: 'work', label: 'Work', words: ['work', 'job', 'boss', 'manager', 'coworker', 'colleague', 'fired', 'laid off', 'career', 'office', 'salary', 'burnout', 'overtime'] },
  { key: 'school', label: 'School', words: ['school', 'exam', 'exams', 'university', 'college', 'class', 'teacher', 'professor', 'grades', 'homework', 'thesis', 'study', 'studying'] },
  { key: 'money', label: 'Money', words: ['money', 'debt', 'rent', 'loan', 'broke', 'bills', 'afford', 'unemployed', 'payment', 'financial'] },
  { key: 'loneliness', label: 'Loneliness', words: ['lonely', 'alone', 'no friends', 'nobody', 'no one', 'isolated', 'left out', 'ignored', 'homesick'] },
  { key: 'grief', label: 'Grief & loss', words: ['died', 'death', 'passed away', 'funeral', 'grief', 'grieving', 'lost my', 'miss him', 'miss her', 'miss them'] },
  { key: 'health', label: 'Health', words: ['sick', 'illness', 'hospital', 'diagnosis', 'diagnosed', 'pain', 'doctor', 'anxiety', 'anxious', 'panic', 'depressed', 'depression', 'sleep', 'insomnia', 'tired'] },
  { key: 'other', label: 'Something else', words: [] },
];

export const TOPIC_KEYS = TOPICS.map((t) => t.key);
const LABELS = Object.fromEntries(TOPICS.map((t) => [t.key, t.label]));

export function topicLabel(key) {
  return LABELS[key] || key;
}

export function topicLabels(keys) {
  return (keys || []).map(topicLabel).join(', ');
}

/** Keep only known topic keys, without duplicates. */
export function cleanTopics(keys) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k) => TOPIC_KEYS.includes(k)))];
}

function mentions(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(text);
}

/** Topics a piece of free text is about, from simple word matching. */
export function detectTopics(text) {
  const found = [];
  for (const t of TOPICS) {
    if (t.words.some((w) => mentions(text || '', w))) found.push(t.key);
  }
  return found;
}

/** The topics to match on: what the person tapped plus what their text mentions. */
export function topicsFor(text, picked) {
  const all = cleanTopics([...(picked || []), ...detectTopics(text)]);
  const specific = all.filter((k) => k !== 'other');
  return specific.length ? specific : ['other'];
}
