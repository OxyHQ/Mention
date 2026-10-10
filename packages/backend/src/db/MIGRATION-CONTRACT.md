# PostgreSQL database prerequisites — Mention

Two RDS facts about provisioning Mention's database that no schema file can
state. The schema rules themselves live in
[`schema/CONVENTIONS.md`](schema/CONVENTIONS.md); read that one.

## PostGIS is a privileged prerequisite, once per database

A NEW target database needs `CREATE EXTENSION postgis;` run by the master user
(an `rds_superuser`) before the migrator can run. The application role cannot
issue it even on a database it OWNS — PostGIS is not a trusted extension, so
ownership is not enough (`permission denied to create extension "postgis"`,
measured twice against RDS as `mention` in August 2026). Without it, the first
migration fails at `type "geography" does not exist`.

`ensureExtensions` runs `create extension if not exists postgis` ahead of every
migration and looks like it covers this. It does not: `IF NOT EXISTS`
short-circuits on the duplicate check **before** the privilege check, so it is a
no-op on a database that already has the extension and a hard failure on one that
does not. Production is satisfied (`spatial_ref_sys` is owned by `rdsadmin`); the
futures where this bites are disaster recovery, a new staging environment, a
region migration.

## Ownership, and why a probe database misrepresents it

`pg_database.datdba` for the production `mention` database is **`mention`**, the
application role itself. Since PG15 `public` is owned by `pg_database_owner`, so
the owning role gets `CREATE` on it, owns every table the migration creates, and
holds full DML by ownership — no `GRANT` anywhere.

A throwaway database created by a different role (`oxyadmin`, say) gives the
application role none of that, and work rehearsed there fails on privileges
production does not have. Two `42501`-shaped failures during a
rehearsal were read as production facts before anyone measured the production
side. **Create a rehearsal target `OWNER mention`**, or it is testing a
configuration that will never exist.

## Where the rest went

The id-remapping decision, the `select: false` replacement, the TTL registry, the
enum-widening rule and the driver choice are all in `schema/CONVENTIONS.md`.
