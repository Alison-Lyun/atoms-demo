# Atoms Demo

Build a real, bounded AI application builder. Users create a project, generate self-contained HTML/CSS/JS using a server-side model, interact with a sandboxed preview, request consecutive changes, persist project and app state, inspect/export source, and restore code versions.

No fabricated model results. Development fixtures are explicit, separate, and disabled in production. Missing credentials remain visible configuration errors. Public cloud deployment requires Supabase with anonymous auth and RLS; local development uses an atomic JSON store with isolated anonymous sessions.

Acceptance: calculator, todo and a third app; two same-project changes; reload recovery; error/timeout/cancel/stale-result handling; candidate data isolation; rollback; cross-user/project isolation; source export and reproducible build. Current model and cloud verification results are recorded in docs/acceptance.md.
