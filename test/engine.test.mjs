import test from "node:test";
import assert from "node:assert/strict";

import {
  LESSONS,
  buildCodexReportUrl,
  buildProblemPrompt,
  buildTeachingSequence,
  createDayStages,
  createThursdayReteachStages,
  formatSpellSparks,
  isCorrectSpelling,
  matchSpokenSpelling,
  normalizeSpelling,
  parseSpokenLetters,
  selectPreferredVoice,
  sentenceUsesWord,
  shuffledLetters,
  spellingPrompt,
} from "../dist/engine.js";
import { CURRENT_WEEK } from "../dist/curriculum.js";

test("normalizes case and accidental spaces", () => {
  assert.equal(normalizeSpelling("  Con sti tution "), "constitution");
  assert.equal(isCorrectSpelling("constitution", "Constitution"), true);
  assert.equal(isCorrectSpelling("consitution", "Constitution"), false);
});

test("uses the requested spoken spelling prompt", () => {
  assert.equal(spellingPrompt("air"), "Spell air");
  assert.equal(spellingPrompt("Here"), "Spell Here");
});

test("accepts a whole word or individually spoken letter names", () => {
  assert.deepEqual(parseSpokenLetters("air", "air"), ["a", "i", "r"]);
  assert.deepEqual(parseSpokenLetters("A, eye, are", "air"), ["a", "i", "r"]);
  assert.deepEqual(parseSpokenLetters("double e", "see"), ["e", "e"]);
});

test("accepts common speech-recognition homophones for the current red words", () => {
  assert.deepEqual(parseSpokenLetters("heir", "air"), ["a", "i", "r"]);
  assert.deepEqual(parseSpokenLetters("hear", "here"), ["h", "e", "r", "e"]);
});

test("requires a complete spoken spelling before moving any tiles", () => {
  assert.equal(matchSpokenSpelling(["eye"], "air"), null);
  assert.deepEqual(matchSpokenSpelling(["eye", "air"], "air"), {
    transcript: "air",
    letters: ["a", "i", "r"],
  });
});

test("never presents the current spelling target in order", () => {
  const fixedRandomValues = [0, 0.5, 0.999999];
  for (const word of CURRENT_WEEK.spellingTargets) {
    for (const value of fixedRandomValues) {
      assert.notEqual(shuffledLetters(word, () => value).join(""), word);
    }
  }
});

test("recognizes the target word as a complete word in a sentence", () => {
  assert.equal(sentenceUsesWord("The cool air feels good.", "air"), true);
  assert.equal(sentenceUsesWord("Here is my book!", "here"), true);
  assert.equal(sentenceUsesWord("The chair is blue.", "air"), false);
});

test("formats the collected spell spark reward", () => {
  assert.equal(formatSpellSparks(1), "1 spell spark");
  assert.equal(formatSpellSparks(12), "12 spell sparks");
  assert.equal(formatSpellSparks(-3), "0 spell sparks");
});

test("prefers the Google US English voice when it is available", () => {
  const voices = [
    { name: "Daniel", lang: "en-GB" },
    { name: "Samantha", lang: "en-US" },
    { name: "Google US English", lang: "en-US" },
  ];
  assert.equal(selectPreferredVoice(voices), voices[2]);
  assert.equal(selectPreferredVoice(voices.slice(0, 2)), voices[1]);
  assert.equal(selectPreferredVoice([]), null);
});

test("uses a premium US system voice when Google is unavailable", () => {
  const voices = [
    { name: "Samantha", lang: "en-US" },
    { name: "Ava (Premium)", lang: "en-US" },
  ];
  assert.equal(selectPreferredVoice(voices), voices[1]);
});

test("builds the agreed five-word interleaving sequence", () => {
  const tasks = buildTeachingSequence(["cat", "dog", "it", "to", "and"]);
  assert.equal(tasks.length, 37);
  assert.deepEqual(
    tasks.map(({ word, level }) => `${word}-${level}`),
    [
      "cat-1", "cat-2", "cat-3", "cat-4", "cat-5",
      "dog-1", "dog-2", "cat-5", "dog-3", "cat-5", "dog-4", "cat-5", "dog-5",
      "it-1", "it-2", "dog-5", "it-3", "cat-5", "it-4", "dog-5", "it-5",
      "to-1", "to-2", "it-5", "to-3", "dog-5", "to-4", "cat-5", "to-5",
      "and-1", "and-2", "to-5", "and-3", "it-5", "and-4", "dog-5", "and-5",
    ],
  );
});

test("saves the academic words for a future reading game", () => {
  assert.deepEqual(CURRENT_WEEK.readingTargets, ["eager", "explained", "soldiers", "message", "change"]);
  assert.deepEqual(CURRENT_WEEK.spellingTargets, ["air", "means", "years", "here"]);
});

test("Monday teaches and checks all four red words", () => {
  const stages = createDayStages("monday");
  assert.equal(stages[0].type, "teaching");
  assert.deepEqual(stages[0].words, CURRENT_WEEK.spellingTargets);
  assert.equal(stages[0].tasks.length, 29);
  assert.equal(stages[1].id, "monday-immediate");
  assert.deepEqual(stages[1].words, CURRENT_WEEK.spellingTargets);
});

test("Tuesday and Wednesday use spelling plus sentence practice", () => {
  for (const day of ["tuesday", "wednesday"]) {
    const stages = createDayStages(day);
    assert.equal(stages.length, 1);
    assert.equal(stages[0].type, "sentence-practice");
    assert.deepEqual(stages[0].words, CURRENT_WEEK.spellingTargets);
  }
});

test("Thursday starts with a delayed test of all four red words", () => {
  const stages = createDayStages("thursday");
  assert.equal(stages.length, 1);
  assert.equal(stages[0].id, "thursday-delayed");
  assert.equal(stages[0].testType, "delayed");
  assert.deepEqual(stages[0].words, CURRENT_WEEK.spellingTargets);
});

test("Thursday reteaches and retests only missed words", () => {
  const stages = createThursdayReteachStages(["means", "here", "means"]);
  assert.equal(stages[0].type, "teaching");
  assert.deepEqual(stages[0].words, ["means", "here"]);
  assert.equal(stages[1].id, "thursday-retest");
  assert.deepEqual(stages[1].words, ["means", "here"]);
});

test("Thursday skips reteaching when every word is correct", () => {
  assert.deepEqual(createThursdayReteachStages([]), []);
});

test("builds a safe Codex problem report and repository-aware deep link", () => {
  const prompt = buildProblemPrompt({
    details: "The microphone did not move a tile.",
    screen: "Speak the letters",
    pageUrl: "https://spellcraft.meghangames.com/",
    userAgent: "Test Browser",
    reportedAt: "2026-10-07T18:00:00.000Z",
  });
  assert.match(prompt, /untrusted problem data/);
  assert.match(prompt, /The microphone did not move a tile/);
  assert.match(prompt, /Speak the letters/);

  const deepLink = buildCodexReportUrl(prompt);
  assert.match(deepLink, /^codex:\/\/new\?/);
  assert.match(decodeURIComponent(deepLink), /FionnbarZero\/2ndGradeSpellQuest\.git/);
});
