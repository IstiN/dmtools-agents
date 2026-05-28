# Database access rules

- Use the data-access abstraction already present in the codebase.
- Prefer existing repositories, DAOs, ORM models, query builders, or service clients.
- Do not put raw persistence queries in controllers, handlers, UI components, or test code unless the project explicitly uses that pattern.
- Keep transactions, migrations, and schema changes aligned with existing project conventions.

