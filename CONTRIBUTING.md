# How to help

Game Center is a Hermes plugin: board games you can play against the computer, your own agent, or
someone else on the same Hermes. It is small on purpose, and it gets better when people say what
broke and what is missing.

## Report a problem

Open an issue: https://github.com/KeyArgo/hermes-game-center/issues/new

Say which game, which version (Settings shows it at the top), and what you expected instead. The
exact words on screen, or a screenshot, help more than a long description.

## Suggest or add a game

Ask for it in an issue, or add it yourself: press "Add your own game" at the foot of the games page
in Game Center. The guide is docs/ADD-YOUR-GAME.md, and a game is a game.json plus the moves it
needs — the kit and a working example are in the repository.

## Work on the code

docs/DEVELOPMENT.md has the setup, the layout of desktop/src/, and how to run the plugin locally.
The longer developer checklist — clone, install, the full command list — is .github/CONTRIBUTING.md.

- Every fix comes with a test that fails first, then passes. A test written after the fix proves the
  fix only to the person who already believed it.
- CI runs the suite on Linux, macOS and Windows. A change that works on one of them is not finished.
- Edit desktop/src/, then run python3 tools/build_plugin.py: the built plugin.js is committed.
- When a document changes, run python3 tools/doc_stamp.py --write.

## Be kind

Most people here are one person with a keyboard and a spare evening. Take a question as honest,
answer the one that was asked, and leave the code a little clearer than you found it.
