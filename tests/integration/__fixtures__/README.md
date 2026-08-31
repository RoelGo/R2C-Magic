# OCR engine integration fixtures

Drop a book cover photo with legible text here as **`cover.jpg`** to enable the
engine integration tests:

```sh
pnpm test:lib:integration
```

The tests are skipped for any engine whose runtime is not installed, and both
engine blocks are skipped entirely when `cover.jpg` is absent — so committing
no image keeps the suite green while still letting the availability report run.

These images are local benchmarking aids and are **not committed** (see
`.gitignore` in this folder).
