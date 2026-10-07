# SpellCraft

SpellCraft is a browser-based spelling tutor for a 15-word civics vocabulary curriculum. It combines scaffolded letter activities, spaced review, delayed tests, child-led self-scoring, targeted Thursday reteaching, and a local progress graph.

## Weekly sequence

- **Monday:** Teach and test the first five words.
- **Tuesday:** Delayed test of Monday's words, then teach and test five new words.
- **Wednesday:** Delayed test of the first ten words, then teach and test the final five.
- **Thursday:** Reteach every word missed on either Wednesday test, then retest those words.

## Learning sequence

Each new word progresses through:

1. Visible unscramble
2. Five-second memory unscramble
3. Independent unscramble
4. Voice-controlled unscramble
5. Typed spelling
6. Delayed-feedback test and self-scoring

Previously mastered words are interleaved at Level 5 while new words are learned. Two errors at a level move the word back one level. Test results are stored only in the current browser.

## Run locally

```sh
npm run serve
```

Then open <http://localhost:4173>.

## Test

```sh
npm test
```

The app has no runtime dependencies. Voice input uses the browser's Speech Recognition API when available and provides a clearly labeled keyboard fallback when it is not.

Every screen includes a **Report a problem** button. It prepares a privacy-conscious diagnostic prompt and opens a new repository-aware Codex chat using the documented `codex://` deep-link scheme. The reporter reviews and sends the message; reports are never submitted silently. A clipboard fallback is included for devices without the Codex desktop app.

Audio prompts begin with “Spell [word],” and each lowercase letter is spoken as the learner places a tile or types. The app prefers Chrome's Google US English voice when it is available and otherwise chooses a natural English voice installed on the device. On computer keyboards, Enter submits typed spelling and advances eligible instruction, feedback, and result screens.
