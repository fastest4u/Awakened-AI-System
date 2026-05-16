# session-start

Call `memory_sessionStart` first, then use `memory_contextPack` for the current task before reading full notes.

Token rule: use `memory_contextPack` before `memory_get` unless the user explicitly asks for a full note.
