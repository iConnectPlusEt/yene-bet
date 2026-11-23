// Optional preferences: who a person is (age range, gender, language) and who
// they would like to talk to. They are soft: they only change the order in
// which people are offered to each other, are never shown to anyone else, and
// never make anyone wait. Everyone is 18 or older, so there is no younger band.
import { db } from './db.js';

export const AGE_BANDS = ['18-24', '25-34', '35-44', '45+'];
export const GENDERS = ['woman', 'man', 'private'];
export const LANGUAGES = ['en', 'am', 'other'];
export const WANT_GENDERS = ['woman', 'man', 'same'];

const pickOne = (value, allowed) => (allowed.includes(value) ? value : null);

/** The bands next to a person's own, for "people about my age". */
export function adjacentBands(band) {
  const i = AGE_BANDS.indexOf(band);
  if (i < 0) return [];
  return AGE_BANDS.filter((_, k) => Math.abs(k - i) <= 1);
}

/** Keep only values we know. Anything else becomes "no preference". */
export function cleanPrefs(input = {}) {
  const wantsAge = Array.isArray(input.wantsAge) ? [...new Set(input.wantsAge.filter((b) => AGE_BANDS.includes(b)))] : [];
  return {
    ageBand: pickOne(input.ageBand, AGE_BANDS),
    gender: pickOne(input.gender, GENDERS),
    language: pickOne(input.language, LANGUAGES),
    wantsAge,
    wantsGender: pickOne(input.wantsGender, WANT_GENDERS),
  };
}

/** The preferences stored on a person's row, in the shape the app uses. */
export function prefsOf(person) {
  return {
    ageBand: person.age_band || null,
    gender: person.gender || null,
    language: person.language_pref || null,
    wantsAge: person.wants_age || [],
    wantsGender: person.wants_gender || null,
  };
}

/** The same values as the match functions in the database take them. */
export function prefArgs(person) {
  const p = prefsOf(person);
  return [p.ageBand, p.gender, p.wantsAge, p.wantsGender];
}

export async function savePrefs(person, input) {
  const p = cleanPrefs(input);
  await db()`
    update people
       set age_band = ${p.ageBand}, gender = ${p.gender}, language_pref = ${p.language},
           wants_age = ${p.wantsAge}, wants_gender = ${p.wantsGender}, prefs_seen_at = now()
     where id = ${person.id}`;
  return p;
}

/** "Skip": remember that the screen was shown, change nothing else. */
export async function skipPrefs(person) {
  await db()`update people set prefs_seen_at = coalesce(prefs_seen_at, now()) where id = ${person.id}`;
}
