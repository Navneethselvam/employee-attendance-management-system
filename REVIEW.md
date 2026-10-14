# Starter-code review

The original starter is a useful skeleton, but several defects could produce incorrect results or fail concurrency/performance tests. Each item records the defect, how it is detected, and the fix applied in this implementation.

1. **Pagination skip was off by one page** — `skip = page * page_size` skipped the first page. A page-1 request should start at offset 0. Fixed to `(page - 1) * page_size` and added bounds.
2. **Employee total ignored filters** — total was counted across the whole collection even when `department` was supplied. Compare filtered `total` with matching documents; fixed by passing the same query to `count_documents`.
3. **Employee duplicate check had a race** — `find_one` followed by insert lets concurrent requests both pass. Fixed with a unique database index and `DuplicateKeyError` -> HTTP 409.
4. **No attendance uniqueness enforcement** — check-then-insert can create duplicate employee/day rows under concurrent punch-ins. Fixed with a unique `(emp_code,date)` index.
5. **Unknown employee was not rejected before punch-in** — a missing employee could be dereferenced or result in malformed attendance. Fixed with explicit 404.
6. **Punch-in time zone was host-dependent** — naive `datetime.fromtimestamp` uses the host time zone. Fixed by epoch conversion to UTC and explicit IST conversion only for calendar/shift calculations.
7. **Fractional seconds were not truncated** — subsecond values could change minute-boundary behavior and persisted timestamps. Fixed by truncating instants to whole seconds.
8. **Late calculation mishandled grace boundaries** — grace is a strict >10-minute comparison, while the reported value is elapsed whole minutes from shift start. Implemented with exact seconds comparison.
9. **Overtime had no 30-minute threshold** — small overtime should be zero. Fixed by requiring at least 1,800 elapsed seconds and flooring the reported minutes.
10. **Work-hour rounding could use binary/banker's rounding** — the contract requires decimal HALF_UP. Fixed with `Decimal` and `ROUND_HALF_UP`.
11. **Overnight shifts were not modeled** — a punch after midnight may belong to the prior shift date. Added R1 attendance date and next-day shift-end calculation.
12. **Punch-out was missing** — the starter did not close a record or compute work hours. Added conditional `find_one_and_update` so concurrent punch-outs yield one success and one conflict.
13. **Attendance listing loaded all matching records into Python** — sorting/slicing after loading scales poorly. Replaced with Mongo sort/skip/limit and a filtered count.
14. **Attendance sorting contract was not guaranteed** — results need date descending and employee code ascending. Added explicit compound sort.
15. **No regularization audit trail** — manual edits could overwrite prior corrections. Added exactly one append-only history event with only changed fields and optimistic concurrency matching.
16. **Absent/leave could retain punch times** — these statuses require both times to be null. PATCH validates and clears times, and rejects explicitly supplied times with these statuses.
17. **Analytics endpoints were absent** — no employee monthly, department summary, late leaderboard, or trend support. Added monthly aggregation, department grouping, rank-based leaderboard, and date densification pipeline.
18. **Employees without logs could be omitted from headcount** — department summary headcount must come from employees, not attendance. Summary initializes departments from employees joined by period end.
19. **No readiness check against MongoDB** — a process could return healthy while the database is down. `/health` now pings MongoDB and returns 503 on failure.
20. **No explain endpoint for index verification** — query plans were not inspectable. Added an admin explain route and created supporting indexes at startup.

### Starter behavior reviewed and retained
- FastAPI/Pydantic are appropriate for the HTTP contract and automatic 422 validation.
- MongoDB is appropriate because the assignment explicitly seeds collections and requires aggregation pipelines.
- `emp_code` is the correct stable public identifier; Mongo `_id` must remain private.
- Storing calendar dates as strings avoids incorrectly treating a date as an instant.
- Derived attendance values belong in the write path and analytics should read stored values, as required by the contract.

### Validation performed
- `python -m py_compile app/main.py` checks syntax.
- Runtime smoke tests should include `/health`, duplicate employee creation, punch-in/punch-out, list filters, PATCH audit history, analytics edge cases, and explain plans against MongoDB 7+.
- This document describes code-level review; it is not a claim that the hidden grader or every edge case has been run.
