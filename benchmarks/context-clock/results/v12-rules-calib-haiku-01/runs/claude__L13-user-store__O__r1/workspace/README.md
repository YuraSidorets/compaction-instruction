# User store

The user data of the members area.

- db/migrations/: the schema migrations, applied in the order of their file names. Each file exports a list of steps.
- src/schema.mjs: applies the migrations and returns the tables with their columns.
- src/users.mjs: helpers for user objects.
