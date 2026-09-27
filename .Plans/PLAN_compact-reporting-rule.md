# PLAN — Compact reporting rule in SYSTEM.md / SYSTEM.html

## Goal (confirmed with user)
Add the user's reporting guide as a governing rule: report prose stays within 3 sentences —
Cause, Progress, Conclusion. Chosen option: **replace prose limits, keep tables** — the
5-section report template stays, its prose slots shrink to the three sentences, and
tables/diagrams/code stay exempt from the sentence limit.

## Scope
1. `.pi/SYSTEM.md`
   - Core Principles table: add a `Compact Reporting` row (box widths preserved).
   - Execution Protocol step 10: shorten to the three-sentence form (box width preserved).
   - Report Format Template: state the three-sentence rule; move all prose into section 1
     (Cause / Progress / Conclusion bullets); sections 2, 3, 5 become "no prose here" slots
     for optional visuals; remove the box-drawing borders around non-table content —
     border lines are for tables only; prose sections use numbered headings and bullet points;
     Key Results becomes a real Markdown table.
2. `SYSTEM.html` — same content, English and Korean, per the AGENTS.md synchronization rule
   (new core-principle row, step 10 row, report-format intro and cards 1/2/3/5).
3. JOURNAL.md entry + this plan file; one commit carrying both SYSTEM files.

## Out of scope
- All other SYSTEM.md sections (box-drawn tables there are genuine tables, kept as-is).
- Extensions code.

## Verification
- Every ASCII box block has uniform row width (script check).
- No box borders remain inside the Report Format Template (script check).
- SYSTEM.html tag balance parses clean (script check).
- Grep: rule text present in both files.
