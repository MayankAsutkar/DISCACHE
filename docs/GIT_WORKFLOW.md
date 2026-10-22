# Git Workflow

## Branching and review

1. Fetch the remote and inspect the current branch before editing:

   ```bash
   git fetch origin
   git status --short --branch
   git log --oneline --decorate -5
   ```

2. Create a focused branch from the current upstream default branch. Keep project changes isolated from `main`:

   ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c feature/short-description
   ```

3. Before staging, review changed paths and ignore generated outputs:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff
   ```

4. Run relevant tests and builds. Record any unavailable environment or integration explicitly; never substitute sample data for a live result.

5. Stage only reviewed paths, inspect the staged diff, and commit with a Conventional Commit subject:

   ```bash
   git add <reviewed-paths>
   git diff --cached --check
   git diff --cached
   git commit -m "feat: describe the change" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
   ```

6. Push the feature branch and open a pull request. Do not force-push, amend a commit, or push directly to `main` unless explicitly authorized:

   ```bash
   git push -u origin HEAD
   ```

## Repository-specific checks

- Node client tests: `npm test`
- Python protocol/benchmark tests: `python -m unittest discover -s tests -v`
- JavaScript syntax: `node --check bridge.js` and `node --check public/app.js`
- POSIX C++ protocol framing test:

  ```bash
  g++ -std=c++20 -Wall -Wextra -pthread -Iinclude tests/protocol_test.cpp -o /tmp/discache-protocol-test
  /tmp/discache-protocol-test
  ```

- C++ services: `make`

The C++ source uses POSIX sockets and needs a compatible compiler/runtime. If the environment cannot provide one, report that limitation instead of marking the build passed.

## Snapshot integration note

The original local project folder supplied for the UI work had no Git metadata. Its files could not be classified as tracked changes or assigned original commits. The feature branch was therefore based on the reachable upstream `main` and the reviewed source files were integrated selectively. Do not describe this as a merge or rebase of the local folder's history.
