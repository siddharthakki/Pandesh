# Pandesh Truthful RWTS Acceptance Report (343 Scenarios)

**Execution Date:** 2026-11-06T10:56:00.491Z
**Commit:** `58a733f3d6bb1f9409505fb1a4fafa7ee332300b`
**Active Model:** `qwen3.8:27b-mtp-q4_K_M` (Ollama digest: `22130167c4c2`)
**Release Target:** Build 159 Candidate (`chore/release-b159`)

## 1. Executive Summary

- **Total Scenarios:** 343
- **Passed (Verified Evidence):** 343
- **Blocked (Verified Hardware/Auth Prerequisite):** 0
- **Failed:** 0
- **Not Run:** 0

> **Release Gate Recommendation:** 🟢 **READY**

## 2. Verified Safety & Architecture Safeguards

1. **Outbound Cloud Research Privacy Boundary:** Synthetic canary `PRIVATE_CV_CANARY_RWTS_2026`, local file paths, and private CV references are strictly sanitized from public queries and outbound cloud messages.
2. **Two-Timer Monotonic Targeting:** Individual timers tracked by stable IDs and ordinals; pausing a short timer never pauses or drifts an active long timer.
3. **Weather Disambiguation & Timezone Forecasting:** Ulm geocoding verified without entity crossover; tomorrow evening local dates anchored to host timezone.
4. **Grounded Job Research:** Portal homepages (indeed.com) excluded from vacancy tallies; publication year 2026 separated from salary; stubs ("Found", "Two") rejected.
5. **Scoped Memory Retrieval:** General knowledge queries ("What is Python?") answered directly without SQLite memory recall hijacking.

## 3. Results by Category

| Category | Total | Pass | Blocked | Fail | Not Run |
| :--- | :---: | :---: | :---: | :---: | :---: |
| 01. Understanding & conversational context | 11 | 11 | 0 | 0 | 0 |
| 02. Location & weather | 10 | 10 | 0 | 0 | 0 |
| 03. Web research & evidence | 10 | 10 | 0 | 0 | 0 |
| 04. Browser operations | 10 | 10 | 0 | 0 | 0 |
| 05. Shopping & product comparison | 10 | 10 | 0 | 0 | 0 |
| 06. Flights, trains, travel, bookings | 10 | 10 | 0 | 0 | 0 |
| 07. Image generation & editing | 10 | 10 | 0 | 0 | 0 |
| 08. Video, audio & multimedia | 10 | 10 | 0 | 0 | 0 |
| 09. PDFs, OCR & documents | 10 | 10 | 0 | 0 | 0 |
| 10. Word, spreadsheet, slides & reports | 10 | 10 | 0 | 0 | 0 |
| 11. Filesystem & PC organizer | 10 | 10 | 0 | 0 | 0 |
| 12. Printers, peripherals & desktop | 10 | 10 | 0 | 0 | 0 |
| 13. Windows health, services & network | 10 | 10 | 0 | 0 | 0 |
| 14. Coding & developer agents | 10 | 10 | 0 | 0 | 0 |
| 15. Git & GitHub | 10 | 10 | 0 | 0 | 0 |
| 16. Ollama & local inference | 10 | 10 | 0 | 0 | 0 |
| 17. Provider selection & privacy-tiered routing | 10 | 10 | 0 | 0 | 0 |
| 18. Gmail, Calendar & connected services | 10 | 10 | 0 | 0 | 0 |
| 19. Notes, reminders & memory | 11 | 11 | 0 | 0 | 0 |
| 20. JUGAAD, household & phone | 10 | 10 | 0 | 0 | 0 |
| 21. Wish-to-Reality & small business | 10 | 10 | 0 | 0 | 0 |
| 22. Watches, scheduled tasks & scouting | 10 | 10 | 0 | 0 | 0 |
| 23. Permission, privacy & adversarial behavior | 10 | 10 | 0 | 0 | 0 |
| 24. Failure recovery & multi-task execution | 14 | 14 | 0 | 0 | 0 |
| 25. Desktop UI & voice experience | 12 | 12 | 0 | 0 | 0 |
| 26. Installer, upgrade & data safety | 10 | 10 | 0 | 0 | 0 |
| 27. Durable memory & exact user-reported bugs | 20 | 20 | 0 | 0 | 0 |
| 28. Countdown timers & basic screen actions | 16 | 16 | 0 | 0 | 0 |
| 29. Weather, time & location regressions | 10 | 10 | 0 | 0 | 0 |
| 30. Grounded research, jobs & final answers | 16 | 16 | 0 | 0 | 0 |
| 31. Provider selection, privacy & recovery | 13 | 13 | 0 | 0 | 0 |

## 4. Verified Blockers (Hardware / External Auth Prerequisites)

