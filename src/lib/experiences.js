// Specific experiences used for matching. A listener who has "lost a parent"
// is a far better match for someone grieving a parent than anyone tagged
// "family". Keys are stored in the database; labels are shown to people; the
// words are a fallback for when the AI tagger is unavailable.
export const EXPERIENCES = [
  // relationships
  { key: 'breakup', topic: 'relationships', label: 'a breakup', words: ['broke up', 'breakup', 'break up', 'dumped me', 'left me', 'my ex'] },
  { key: 'cheated_on', topic: 'relationships', label: 'being cheated on', words: ['cheated on me', 'cheating on me', 'affair', 'unfaithful'] },
  { key: 'divorce', topic: 'relationships', label: 'divorce or separation', words: ['divorce', 'divorced', 'separated', 'separation'] },
  { key: 'unrequited_love', topic: 'relationships', label: 'loving someone who does not love you back', words: ['does not love me', "doesn't love me", 'friend zone', 'unrequited', 'rejected me'] },
  { key: 'toxic_relationship', topic: 'relationships', label: 'a controlling or hurtful relationship', words: ['controlling', 'toxic', 'manipulative', 'manipulated', 'manipulates', 'abusive', 'gaslighting', 'gaslights'] },
  { key: 'marriage_trouble', topic: 'relationships', label: 'trouble in a marriage', words: ['my husband', 'my wife', 'marriage'] },
  { key: 'long_distance', topic: 'relationships', label: 'a long-distance relationship', words: ['long distance', 'long-distance'] },
  // family
  { key: 'parent_conflict', topic: 'family', label: 'conflict with parents', words: ['my parents and i', 'fight with my parents', 'my mom and i', 'my mother and i', 'my dad and i', 'my father and i', 'fight with my mom', 'fight with my mother', 'fight with my dad', 'fight with my father', 'strict parents'] },
  { key: 'family_pressure', topic: 'family', label: 'family pressure and expectations', words: ['expectations', 'expects me', 'expect me', 'pressure from', 'compare me', 'comparing me', 'disappointed in me', 'disappointment', 'forced to'] },
  { key: 'sibling_conflict', topic: 'family', label: 'conflict with a sibling', words: ['my sister', 'my brother', 'sibling'] },
  { key: 'parents_divorce', topic: 'family', label: "parents' divorce", words: ['parents divorced', 'parents are divorcing', 'parents separated', 'parents split'] },
  { key: 'caring_for_family', topic: 'family', label: 'caring for a sick family member', words: ['taking care of my', 'caring for my', 'caregiver', 'look after my'] },
  { key: 'parenting', topic: 'family', label: 'the strain of raising children', words: ['my kids', 'my son', 'my daughter', 'my baby', 'single mother', 'single father', 'single parent'] },
  { key: 'in_laws', topic: 'family', label: 'trouble with in-laws', words: ['in-law', 'in laws', 'mother-in-law', 'father-in-law'] },
  // work
  { key: 'job_loss', topic: 'work', label: 'losing a job', words: ['fired', 'laid off', 'lost my job', 'let go', 'redundant'] },
  { key: 'unemployment', topic: 'work', label: 'not finding work', words: ['unemployed', 'no job', "can't find a job", 'cannot find a job', 'job hunting', 'rejections'] },
  { key: 'bad_boss', topic: 'work', label: 'a difficult boss', words: ['my boss', 'my manager', 'supervisor'] },
  { key: 'burnout', topic: 'work', label: 'burnout', words: ['burnout', 'burned out', 'burnt out', 'overworked', 'overtime', 'exhausted from work'] },
  { key: 'workplace_bullying', topic: 'work', label: 'being mistreated at work', words: ['coworker', 'coworkers', 'colleague', 'colleagues', 'humiliated', 'bullied at work', 'harassed', 'harassment'] },
  { key: 'career_doubt', topic: 'work', label: 'doubting a career path', words: ['wrong career', 'hate my job', 'career', 'quit my job'] },
  { key: 'business_failure', topic: 'work', label: 'a business that failed', words: ['my business', 'my shop', 'bankrupt', 'startup failed'] },
  // school
  { key: 'exam_failure', topic: 'school', label: 'failing an exam', words: ['failed my exam', 'failed the exam', 'failed my', 'bad grades', 'failing'] },
  { key: 'exam_stress', topic: 'school', label: 'exam pressure', words: ['exam', 'exams', 'finals', 'deadline', 'thesis'] },
  { key: 'school_bullying', topic: 'school', label: 'being bullied at school', words: ['bullied', 'bully', 'classmates', 'made fun of'] },
  { key: 'university_admission', topic: 'school', label: 'not getting into university', words: ['did not get in', "didn't get in", 'entrance exam', 'admission', 'not accepted'] },
  { key: 'dropping_out', topic: 'school', label: 'dropping out or wanting to', words: ['drop out', 'dropped out', 'dropping out', 'quit school'] },
  // money
  { key: 'debt', topic: 'money', label: 'debt', words: ['debt', 'loan', 'owe money', 'borrowed'] },
  { key: 'cant_afford', topic: 'money', label: 'not being able to cover basics', words: ['rent', 'afford', 'bills', 'no money', 'broke'] },
  { key: 'supporting_family', topic: 'money', label: 'supporting family on little money', words: ['support my family', 'provide for', 'send money', 'breadwinner'] },
  { key: 'scammed', topic: 'money', label: 'being cheated out of money', words: ['scammed', 'scam', 'stole my money', 'cheated me out'] },
  // loneliness
  { key: 'new_city', topic: 'loneliness', label: 'moving somewhere new', words: ['new city', 'moved to', 'moved away', 'new country', 'abroad', 'homesick'] },
  { key: 'no_friends', topic: 'loneliness', label: 'having no close friends', words: ['no friends', 'no one to talk', 'nobody to talk', 'left out', 'alone'] },
  { key: 'lost_friendship', topic: 'loneliness', label: 'losing a close friend', words: ['best friend', 'friendship ended', 'my friend stopped', 'betrayed by'] },
  { key: 'feeling_invisible', topic: 'loneliness', label: 'feeling unseen', words: ['invisible', 'nobody cares', 'no one cares', 'ignored', 'unwanted'] },
  // grief
  { key: 'lost_parent', topic: 'grief', label: 'losing a parent', words: ['mother died', 'father died', 'mom died', 'dad died', 'mother passed', 'father passed', 'mom passed', 'dad passed', 'lost my mother', 'lost my father', 'lost my mom', 'lost my dad'] },
  { key: 'lost_partner', topic: 'grief', label: 'losing a partner', words: ['husband died', 'wife died', 'husband passed', 'wife passed', 'lost my husband', 'lost my wife', 'widow'] },
  { key: 'lost_child', topic: 'grief', label: 'losing a child', words: ['lost my son', 'lost my daughter', 'lost my baby', 'lost my child', 'stillborn'] },
  { key: 'lost_friend', topic: 'grief', label: 'losing a friend', words: ['friend died', 'friend passed', 'lost my friend', 'lost my best friend'] },
  { key: 'lost_sibling', topic: 'grief', label: 'losing a sibling', words: ['brother died', 'sister died', 'brother passed', 'sister passed', 'lost my brother', 'lost my sister'] },
  { key: 'miscarriage', topic: 'grief', label: 'miscarriage', words: ['miscarriage', 'miscarried', 'lost the pregnancy'] },
  // health
  { key: 'anxiety', topic: 'health', label: 'anxiety', words: ['anxiety', 'anxious', 'panic attack', 'panic', 'overthinking'] },
  { key: 'depression', topic: 'health', label: 'feeling depressed', words: ['depressed', 'depression', 'hopeless', 'empty inside', 'numb'] },
  { key: 'chronic_illness', topic: 'health', label: 'living with an illness', words: ['diagnosed', 'diagnosis', 'chronic', 'my illness', 'hospital'] },
  { key: 'sleep', topic: 'health', label: 'not being able to sleep', words: ["can't sleep", 'cannot sleep', 'insomnia', 'not sleeping'] },
  { key: 'body_image', topic: 'health', label: 'struggling with how you look', words: ['my body', 'my weight', 'ugly', 'fat'] },
  { key: 'addiction', topic: 'health', label: 'addiction', words: ['addicted', 'addiction', 'drinking', 'alcohol', 'gambling', 'relapse'] },
  { key: 'low_self_worth', topic: 'health', label: 'feeling not good enough', words: ['not good enough', 'worthless', 'failure', 'hate myself', 'useless'] },
];

export const EXPERIENCE_KEYS = EXPERIENCES.map((e) => e.key);
const BY_KEY = Object.fromEntries(EXPERIENCES.map((e) => [e.key, e]));

export const experienceLabel = (key) => BY_KEY[key]?.label || key;
export const experienceLabels = (keys) => (keys || []).map(experienceLabel).join(', ');

/** Keep only known experience keys, without duplicates, at most `max`. */
export function cleanExperiences(keys, max = 6) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k) => EXPERIENCE_KEYS.includes(k)))].slice(0, max);
}

/** The broad topics a set of experiences belongs to. */
export function topicsOfExperiences(keys) {
  return [...new Set((keys || []).map((k) => BY_KEY[k]?.topic).filter(Boolean))];
}

// Whole words only, so "fat" does not match "father".
function mentions(lower, phrase) {
  let from = 0;
  for (;;) {
    const at = lower.indexOf(phrase, from);
    if (at < 0) return false;
    const before = lower[at - 1] || ' ';
    const after = lower[at + phrase.length] || ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

// Someone grieving a relative mentions them without being in conflict with them.
const CONFLICT_KEYS = ['parent_conflict', 'sibling_conflict', 'marriage_trouble', 'parenting'];

/** Experiences mentioned in free text, from simple word matching. */
export function detectExperiences(text) {
  const lower = String(text || '').toLowerCase();
  let found = EXPERIENCES.filter((e) => e.words.some((w) => mentions(lower, w))).map((e) => e.key);
  if (found.some((key) => BY_KEY[key].topic === 'grief')) found = found.filter((key) => !CONFLICT_KEYS.includes(key));
  return cleanExperiences(found);
}

/** 'am' when the text is mostly in Ethiopic script, otherwise 'en'. */
export function detectLanguage(text) {
  const s = String(text || '');
  const ethiopic = (s.match(/[ሀ-፿]/g) || []).length;
  const latin = (s.match(/[a-z]/gi) || []).length;
  return ethiopic > latin ? 'am' : 'en';
}
