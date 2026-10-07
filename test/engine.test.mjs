import test from "node:test";
import assert from "node:assert/strict";

import {
  LESSONS,
  buildCodexReportUrl,
  buildProblemPrompt,
  buildTeachingSequence,
  createDayStages,
  isCorrectSpelling,
  normalizeSpelling,
  spellingPrompt,
} from "../dist/engine.js";

test("normalizes case and accidental spaces", () => {
  assert.equal(normalizeSpelling("  Con sti tution "), "constitution");
  assert.equal(isCorrectSpelling("constitution", "Constitution"), true);
  assert.equal(isCorrectSpelling("consitution", "Constitution"), false);
});

test("uses the requested spoken spelling prompt", () => {
  assert.equal(spellingPrompt("compromise"), "Spell compromise");
  assert.equal(spellingPrompt("Constitution"), "Spell Constitution");
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

test("Tuesday starts with Monday's delayed test", () => {
  const stages = createDayStages("tuesday");
  assert.equal(stages[0].id, "tuesday-delayed");
  assert.deepEqual(stages[0].words, LESSONS.monday.words);
  assert.equal(stages[1].type, "teaching");
});

test("Wednesday starts with ten prior words and ends with five new words", () => {
  const stages = createDayStages("wednesday");
  assert.equal(stages[0].words.length, 10);
  assert.deepEqual(stages[2].words, LESSONS.wednesday.words);
});

test("Thursday combines misses from both Wednesday tests", () => {
  const history = [
    { testId: "wednesday-delayed", missedWords: ["consent", "federalism"] },
    { testId: "wednesday-immediate", missedWords: ["ordain", "amendment"] },
  ];
  const stages = createDayStages("thursday", history);
  assert.equal(stages[0].type, "teaching");
  assert.deepEqual(stages[0].words, ["consent", "federalism", "ordain", "amendment"]);
  assert.deepEqual(stages[1].words, stages[0].words);
});

test("Thursday requires completed Wednesday tests", () => {
  assert.equal(createDayStages("thursday", [])[0].type, "needs-wednesday");
});

test("Thursday recognizes full Wednesday mastery", () => {
  const history = [
    { testId: "wednesday-delayed", missedWords: [] },
    { testId: "wednesday-immediate", missedWords: [] },
  ];
  assert.equal(createDayStages("thursday", history)[0].type, "mastery");
});

test("Thursday uses misses from the latest fully completed Wednesday session", () => {
  const history = [
    { sessionId: "older", testId: "wednesday-delayed", missedWords: ["consent"] },
    { sessionId: "older", testId: "wednesday-immediate", missedWords: ["ordain"] },
    { sessionId: "unfinished", testId: "wednesday-delayed", missedWords: ["federal"] },
  ];
  const stages = createDayStages("thursday", history);
  assert.deepEqual(stages[0].words, ["consent", "ordain"]);
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
  assert.match(decodeURIComponent(deepLink), /FionnbarZero\/spellcraft\.git/);
});
