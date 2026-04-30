# Backend architecture rules

- Keep business logic out of transport handlers and controllers.
- Put data access behind repositories, gateways, service clients, or the equivalent project abstraction.
- Keep validation, authorization, and error mapping explicit.
- Preserve existing dependency-injection and layering patterns.
- Avoid broad refactors unless the ticket requires them.

