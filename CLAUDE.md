# md2pdf

The Markdown renderer, styles and macOS CLI behind md2pdf.me, published to npm as `@threepenny/md2pdf`. The README covers usage, embedding and development. `npm test` runs the end-to-end tests and needs Google Chrome; `npm run demo` serves the embedding demo on port 3900.

## Roadmap

md2pdf has no Project of its own. Its issues live on the "md2pdf.me Roadmap" Project (https://github.com/users/jbrecht/projects/5) beside the site's, and that Project is linked to this repo, so `kit:roadmap` finds it. md2pdf.me's CLAUDE.md describes how the board is run; the same rules apply here:
- **Labels:** `bug` or `enhancement`. Never priority.
- **Owner:** John, who sets Priority and milestones and approves new issues.
- **Why** a decision was made goes in the issue, as a "Decision (John, date)" line or a comment.

New work becomes an issue first (labels, Status Todo); John sets Priority.
Starting work on an issue: set its Status to In Progress, and put `Fixes #N` in the PR (`Part of #N` while a criterion can only be checked after merge; `kit:do-issue` step 7 has the rule).

## Releases

md2pdf.me depends on a released version, so a change the site needs ships as a release:
1. The PR bumps the version in `package.json` and `package-lock.json`.
2. After John merges, the merge commit is tagged `vX.Y.Z` (annotated) and the tag pushed.
3. John publishes to npm (`npm publish`; publishing can't be undone).
4. md2pdf.me moves to the new version in its own issue.

A change to the styles must keep the CLI's PDFs pixel-identical unless the look is meant to change, and md2pdf.me checks its own pages against the new version before it moves. Check a style or renderer change against `main` with `kit:pdf-check`.
