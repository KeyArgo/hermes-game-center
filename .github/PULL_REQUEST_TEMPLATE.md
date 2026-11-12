## What and why

## How it was tested
- [ ] The test suite passes locally (`python3 -m pytest tests -q -p no:cacheprovider`)
- [ ] `node tests/table_ui_harness.cjs` and `node tests/jackpot_overlay_harness.cjs` pass
- [ ] `python3 tools/build_plugin.py --check` passes (or the rebuilt bundle is included)
- [ ] `hermes plugins validate .` passes
- [ ] A new or changed test covers this change

## Privacy, network and capabilities
- [ ] No new network calls, stored data or capabilities — or they are described above
- [ ] No secrets, recovery keys, personal data or local paths are in the diff, tests or screenshots

## Docs
- [ ] Documents touched by this change are re-read and stamped (`python3 tools/doc_stamp.py --write`)
- [ ] New documents are added to `docs/doc-map.json`
