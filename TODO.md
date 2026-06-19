🔎 = Feature/functionality missing that was present in ts forest

🆕 = New feature/functionality

🐛 = Working, needs a bug fix

✅ = Complete

❌ = Rejected

---

* ✅ ~~trade reports should show both accounts for linked players.~~ // confirm embed "Between" line shows `<@discord> [mcname](namemc) ↔️ [mcname](namemc) <@discord>` for linked parties; falls back gracefully for unlinked
* ✅ ~~add trade reset command to /mod, resets trades from specified user. Should be soft change so it can be unreset, which should also be present~~ // reset/unreset via status suffix `_reset`; works for Discord user + MC UUID; announces in #verified-trades + in-game; requires reason
* ✅ ~~**bug**: trades from craftbot aren't showing up in discord prod. Needs diagnosis~~ // not actually a bug, discord perms weren't sane in refined union
* ✅ ~~**bug**: /tradestats not taking uuid for `mc_user`, only takes flat username.~~ // UUID regex check in `showStatsByMcUser` + `showTradesByMcUser`; skips `/convert-username-to-uuid` when input is already a UUID; resolves UUID→username via `/tradebot/mc-username/:uuid`; embed title links to NameMC via `setURL()`